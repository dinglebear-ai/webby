defmodule Webby.Invocations do
  @moduledoc "Routes an authorized MCP call to one immutable browser document."

  import Ecto.Query
  alias Webby.{BrowserConnections, InvocationAudit, Repo}
  require Logger

  @completion_attempts 3

  def call(registration, session, tool_name, arguments, context) do
    started = System.monotonic_time()

    payload = %{
      "tab_id" => session.tab_id,
      "document_id" => session.document_id,
      "catalog_revision" => session.catalog_revision,
      "tool_name" => tool_name,
      "arguments" => arguments
    }

    case begin_audit(registration, session, tool_name, context) do
      {:ok, audit} ->
        Logger.info("page tool call started",
          event: "page.call.start",
          browser_id: session.browser_id,
          registration_id: registration.id,
          session_id: session.id,
          catalog_revision: session.catalog_revision
        )

        external_key = {context[:credential_id], context[:request_id]}

        timeout = Application.get_env(:webby, :invocation_timeout_ms, 15_000)

        result =
          BrowserConnections.call(session.browser_id, payload, timeout, external_key, audit.id)

        duration = elapsed_ms(started)
        finish_audit(audit, result, duration)
        log_finish(registration, session, result, duration)
        result

      {:error, reason} ->
        Logger.error("page tool call audit unavailable",
          event: "page.call.audit_failed",
          reason: inspect(reason)
        )

        {:error, "audit_unavailable", "The invocation audit could not be initialized"}
    end
  end

  defp begin_audit(registration, session, tool_name, context) do
    %InvocationAudit{}
    |> InvocationAudit.changeset(%{
      credential_id: context[:credential_id],
      registration_id: registration.id,
      session_id: session.id,
      browser_id: session.browser_id,
      tool_name: tool_name,
      catalog_revision: session.catalog_revision,
      outcome: "started",
      duration_ms: 0
    })
    |> Repo.insert()
  end

  def reconcile_abandoned(cutoff \\ DateTime.add(now(), -60, :second)) do
    reconciled_at = now()

    query =
      from a in InvocationAudit,
        where: a.outcome == "started" and a.inserted_at <= ^cutoff,
        update: [
          set: [
            outcome: "abandoned",
            error_kind: "interrupted",
            duration_ms:
              fragment(
                "MAX(0, CAST((julianday(?) - julianday(?)) * 86400000 AS INTEGER))",
                ^reconciled_at,
                a.inserted_at
              )
          ]
        ]

    Repo.update_all(query, [])
    |> then(fn {count, _} -> {:ok, count} end)
  end

  def prune_before(cutoff, batch_size \\ 500)
      when is_struct(cutoff, DateTime) and batch_size in 1..5_000 do
    {examined, deleted} = prune_before_diagnostics(cutoff, batch_size)
    _ = examined
    {:ok, deleted}
  end

  @doc false
  def prune_before_diagnostics(cutoff, batch_size)
      when is_struct(cutoff, DateTime) and batch_size in 1..5_000 do
    ids =
      Repo.all(
        from a in InvocationAudit,
          where: a.inserted_at < ^cutoff and a.outcome != "started",
          order_by: [asc: a.inserted_at],
          limit: ^batch_size,
          select: a.id
      )

    {count, _} =
      case ids do
        [] -> {0, nil}
        ids -> Repo.delete_all(from a in InvocationAudit, where: a.id in ^ids)
      end

    {length(ids), count}
  end

  defp finish_audit(audit, result, duration) do
    {outcome, error_kind} =
      case result do
        {:ok, _value} -> {"succeeded", nil}
        {:error, kind, _message} -> {"failed", kind}
      end

    case complete_audit(audit.id, outcome, error_kind, duration) do
      {:ok, _updated} ->
        :ok

      {:error, {reason, stacktrace}} ->
        Logger.error(
          "page tool call audit completion failed audit_id=#{audit.id} " <>
            "retry_count=#{@completion_attempts - 1} " <>
            "stacktrace=#{Exception.format_stacktrace(stacktrace)}",
          event: "page.call.audit_failed",
          reason: Exception.message(reason)
        )
    end
  end

  defp log_finish(registration, session, result, duration) do
    kind =
      case result do
        {:ok, _value} -> "succeeded"
        {:error, error_kind, _message} -> error_kind
      end

    Logger.info("page tool call finished",
      event: "page.call.finish",
      browser_id: session.browser_id,
      registration_id: registration.id,
      session_id: session.id,
      catalog_revision: session.catalog_revision,
      outcome: kind,
      duration_ms: duration
    )
  end

  @doc false
  def complete_audit(id, outcome, error_kind, duration, opts \\ []) do
    attempts = Keyword.get(opts, :attempts, @completion_attempts)
    update_fun = Keyword.get(opts, :update_fun, &update_audit/4)

    :global.trans(
      {__MODULE__, :audit_completion},
      fn -> complete_with_retry(id, outcome, error_kind, duration, attempts, update_fun) end
    )
  end

  defp complete_with_retry(id, outcome, error_kind, duration, attempts, update_fun) do
    case update_fun.(id, outcome, error_kind, duration) do
      {1, _} -> {:ok, :completed}
      {0, _} -> {:ok, :already_completed}
    end
  rescue
    exception ->
      cond do
        transient_db_failure?(exception) and attempts > 1 ->
          complete_with_retry(id, outcome, error_kind, duration, attempts - 1, update_fun)

        transient_db_failure?(exception) ->
          {:error, {exception, __STACKTRACE__}}

        true ->
          reraise exception, __STACKTRACE__
      end
  end

  defp update_audit(id, outcome, error_kind, duration) do
    Repo.update_all(
      from(a in InvocationAudit, where: a.id == ^id and a.outcome == "started"),
      set: [outcome: outcome, error_kind: error_kind, duration_ms: duration]
    )
  end

  defp transient_db_failure?(%Exqlite.Error{message: message}) do
    normalized = String.downcase(message)

    String.contains?(normalized, "database is locked") or
      String.contains?(normalized, "database is busy")
  end

  defp transient_db_failure?(_exception), do: false

  defp elapsed_ms(started),
    do: System.convert_time_unit(System.monotonic_time() - started, :native, :millisecond)

  defp now, do: DateTime.utc_now() |> DateTime.truncate(:second)
end
