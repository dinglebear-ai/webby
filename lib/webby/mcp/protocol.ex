defmodule Webby.MCP.Protocol do
  @moduledoc "Version-aware MCP JSON-RPC dispatch."

  alias Webby.MCP.Broker

  @latest "2026-07-28"
  @supported [@latest, "2025-11-25", "2025-06-18", "2025-03-26"]

  def supported_versions, do: @supported

  def handle(request, context \\ %{})

  def handle(%{"jsonrpc" => "2.0", "method" => "initialize", "id" => id} = request, _context) do
    requested = get_in(request, ["params", "protocolVersion"])
    version = if requested in @supported, do: requested, else: @latest

    response(id, %{
      "protocolVersion" => version,
      "capabilities" => %{"tools" => %{"listChanged" => false}},
      "serverInfo" => %{"name" => "webby", "version" => "0.1.0"},
      "instructions" =>
        "Use the webby broker tool to inspect explicitly registered browser pages."
    })
  end

  def handle(%{"jsonrpc" => "2.0", "method" => "ping", "id" => id}, _context),
    do: response(id, %{})

  def handle(%{"jsonrpc" => "2.0", "method" => "tools/list", "id" => id}, _context),
    do: response(id, %{"resultType" => "complete", "tools" => [Broker.tool()]})

  def handle(
        %{
          "jsonrpc" => "2.0",
          "method" => "tools/call",
          "id" => id,
          "params" => %{"name" => "webby", "arguments" => arguments}
        },
        context
      ) do
    case Broker.call(arguments, Map.put(context, :request_id, id)) do
      {:ok, value} ->
        response(id, tool_result(value, false))

      {:error, kind, message} ->
        response(id, tool_result(%{"kind" => kind, "message" => message}, true))
    end
  end

  def handle(%{"jsonrpc" => "2.0", "method" => "notifications/initialized"}, _context),
    do: :accepted

  def handle(
        %{
          "jsonrpc" => "2.0",
          "method" => "notifications/cancelled",
          "params" => %{"requestId" => id}
        },
        context
      ) do
    Webby.BrowserConnections.cancel({context[:credential_id], id})
    :accepted
  end

  def handle(%{"jsonrpc" => "2.0", "method" => method, "id" => id}, _context)
      when is_binary(method),
      do: error(id, -32_601, "Method not found")

  def handle(%{"jsonrpc" => "2.0", "method" => _method}, _context), do: :accepted
  def handle(_request, _context), do: error(nil, -32_600, "Invalid Request")

  defp tool_result(value, error?) do
    %{
      "content" => [%{"type" => "text", "text" => Jason.encode!(value)}],
      "structuredContent" => value,
      "isError" => error?,
      "resultType" => "complete"
    }
  end

  defp response(id, result),
    do: {:response, %{"jsonrpc" => "2.0", "id" => id, "result" => result}}

  defp error(id, code, message),
    do:
      {:response,
       %{"jsonrpc" => "2.0", "id" => id, "error" => %{"code" => code, "message" => message}}}
end
