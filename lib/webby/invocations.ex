defmodule Webby.Invocations do
  @moduledoc "Routes an authorized MCP call to one immutable browser document."

  import Ecto.Query
  alias Webby.{BrowserConnections, InvocationAudit, Repo}
  require Logger

  @timeout 15_000
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
        result = BrowserConnections.call(session.browser_id, payload, @timeout, external_key)
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
    ids =
      Repo.all(
        from a in InvocationAudit,
          where: a.inserted_at < ^cutoff and a.outcome != "started",
          order_by: [asc: a.inserted_at],
          limit: ^batch_size,
          select: a.id
      )

    {count, _} = Repo.delete_all(from a in InvocationAudit, where: a.id in ^ids)
    {:ok, count}
  end

  defp finish_audit(audit, result, duration) do
    {outcome, error_kind} =
      case result do
        {:ok, _value} -> {"succeeded", nil}
        {:error, kind, _message} -> {"failed", kind}
      end

    case complete_with_retry(audit.id, outcome, error_kind, duration, @completion_attempts) do
      {:ok, _updated} ->
        :ok

      {:error, reason} ->
        Logger.error("page tool call audit completion failed",
          event: "page.call.audit_failed",
          reason: inspect(reason)
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

  defp complete_with_retry(id, outcome, error_kind, duration, attempts) do
    case Repo.update_all(
           from(a in InvocationAudit, where: a.id == ^id and a.outcome == "started"),
           set: [outcome: outcome, error_kind: error_kind, duration_ms: duration]
         ) do
      {1, _} -> {:ok, :completed}
      {0, _} -> {:ok, :already_completed}
    end
  rescue
    exception ->
      if attempts > 1 do
        complete_with_retry(id, outcome, error_kind, duration, attempts - 1)
      else
        {:error, exception}
      end
  end

  defp elapsed_ms(started),
    do: System.convert_time_unit(System.monotonic_time() - started, :native, :millisecond)

  defp now, do: DateTime.utc_now() |> DateTime.truncate(:second)
end
