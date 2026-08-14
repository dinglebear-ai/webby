defmodule WebbyWeb.MCPController do
  use WebbyWeb, :controller

  alias Webby.MCP.{Credentials, Protocol}

  def create(conn, request) do
    with :ok <- valid_origin(conn),
         :ok <- valid_accept(conn),
         {:ok, credential} <- authenticate(conn),
         true <- Credentials.scope?(credential, required_scope(request)),
         :ok <- valid_version(conn, request) do
      dispatch(conn, Protocol.handle(request, %{credential_id: credential.id}))
    else
      {:error, :invalid_origin} ->
        json_error(conn, 403, "invalid_origin")

      {:error, :invalid_accept} ->
        json_error(conn, 406, "invalid_accept")

      {:error, :invalid_credential} ->
        conn
        |> put_resp_header("www-authenticate", "Bearer")
        |> json_error(401, "invalid_credential")

      {:error, :invalid_version} ->
        json_error(conn, 400, "unsupported_protocol_version")

      false ->
        json_error(conn, 403, "insufficient_scope")
    end
  end

  def listen(conn, _params), do: send_resp(conn, 405, "")

  defp dispatch(conn, :accepted), do: send_resp(conn, 202, "")

  defp dispatch(conn, {:response, response}) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(200, Jason.encode!(response))
  end

  defp authenticate(conn) do
    case get_req_header(conn, "authorization") do
      ["Bearer " <> token] -> Credentials.authenticate(token)
      _missing -> {:error, :invalid_credential}
    end
  end

  defp valid_origin(conn) do
    case get_req_header(conn, "origin") do
      [] -> :ok
      [origin] -> if local_origin?(origin), do: :ok, else: {:error, :invalid_origin}
      _many -> {:error, :invalid_origin}
    end
  end

  defp local_origin?(origin) do
    case URI.parse(origin) do
      %URI{scheme: scheme, host: host} when scheme in ["http", "https"] ->
        host in ["127.0.0.1", "localhost", "::1"]

      _invalid ->
        false
    end
  end

  defp valid_accept(conn) do
    accepted = get_req_header(conn, "accept") |> Enum.join(",")

    if String.contains?(accepted, "application/json") and
         String.contains?(accepted, "text/event-stream"),
       do: :ok,
       else: {:error, :invalid_accept}
  end

  defp valid_version(_conn, %{"method" => "initialize"}), do: :ok

  defp valid_version(conn, request) do
    header = get_req_header(conn, "mcp-protocol-version") |> List.first()
    body_version = get_in(request, ["params", "_meta", "io.modelcontextprotocol/protocolVersion"])

    cond do
      header not in Protocol.supported_versions() ->
        {:error, :invalid_version}

      header == "2026-07-28" and not valid_latest_request?(conn, request, body_version) ->
        {:error, :invalid_version}

      true ->
        :ok
    end
  end

  defp valid_latest_request?(conn, request, body_version) do
    metadata = get_in(request, ["params", "_meta"]) || %{}
    method = request["method"]
    mirrored_method = get_req_header(conn, "mcp-method") |> List.first()
    mirrored_name = get_req_header(conn, "mcp-name") |> List.first()
    expected_name = get_in(request, ["params", "name"])

    body_version == "2026-07-28" and is_map(metadata["io.modelcontextprotocol/clientInfo"]) and
      is_map(metadata["io.modelcontextprotocol/clientCapabilities"]) and mirrored_method == method and
      (method != "tools/call" or mirrored_name == expected_name)
  end

  defp json_error(conn, status, kind) do
    body = %{"jsonrpc" => "2.0", "id" => nil, "error" => %{"code" => -32_000, "message" => kind}}
    conn |> put_status(status) |> json(body)
  end

  defp required_scope(%{
         "method" => "tools/call",
         "params" => %{
           "name" => "webby",
           "arguments" => %{"action" => "page.call"}
         }
       }),
       do: "call"

  defp required_scope(%{"method" => "notifications/cancelled"}), do: "call"

  defp required_scope(_request), do: "read"
end
