defmodule Webby.Invocations do
  @moduledoc "Routes an authorized MCP call to one immutable browser document."

  alias Webby.{BrowserConnections, InvocationAudit, Repo}
  require Logger

  @timeout 15_000

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
        finish_audit(audit, result, started)
        log_finish(registration, session, result, started)
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

  defp finish_audit(audit, result, started) do
    duration = System.convert_time_unit(System.monotonic_time() - started, :native, :millisecond)

    {outcome, error_kind} =
      case result do
        {:ok, _value} -> {"succeeded", nil}
        {:error, kind, _message} -> {"failed", kind}
      end

    case audit
         |> InvocationAudit.changeset(%{
           outcome: outcome,
           error_kind: error_kind,
           duration_ms: duration
         })
         |> Repo.update() do
      {:ok, _updated} ->
        :ok

      {:error, reason} ->
        Logger.error("page tool call audit completion failed",
          event: "page.call.audit_failed",
          reason: inspect(reason)
        )
    end
  end

  defp log_finish(registration, session, result, started) do
    duration = System.convert_time_unit(System.monotonic_time() - started, :native, :millisecond)

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
end
