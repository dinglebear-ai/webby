defmodule WebbyWeb.MCPControllerTest do
  use WebbyWeb.ConnCase, async: false

  alias Webby.MCP.Credentials

  setup do
    {:ok, _credential, token} = Credentials.create("Test MCP client")
    %{token: token}
  end

  test "negotiates legacy initialization and exposes one stable broker tool", %{
    conn: conn,
    token: token
  } do
    response =
      conn
      |> mcp_headers(token)
      |> post("/mcp", %{
        "jsonrpc" => "2.0",
        "id" => 1,
        "method" => "initialize",
        "params" => %{"protocolVersion" => "2025-06-18", "capabilities" => %{}}
      })
      |> json_response(200)

    assert response["result"]["protocolVersion"] == "2025-06-18"
    assert response["result"]["capabilities"] == %{"tools" => %{"listChanged" => false}}

    tools =
      build_conn()
      |> mcp_headers(token, "2025-06-18")
      |> post("/mcp", %{"jsonrpc" => "2.0", "id" => 2, "method" => "tools/list"})
      |> json_response(200)

    assert [%{"name" => "webby", "inputSchema" => schema}] = tools["result"]["tools"]
    assert tools["result"]["resultType"] == "complete"
    assert "page.tools" in schema["properties"]["action"]["enum"]
    refute "page.call" in schema["properties"]["action"]["enum"]
  end

  test "calls a read-only broker action with structured content", %{conn: conn, token: token} do
    response =
      conn
      |> mcp_headers(token, "2025-06-18")
      |> post("/mcp", %{
        "jsonrpc" => "2.0",
        "id" => 3,
        "method" => "tools/call",
        "params" => %{"name" => "webby", "arguments" => %{"action" => "browser.list"}}
      })
      |> json_response(200)

    assert response["result"]["isError"] == false
    assert response["result"]["structuredContent"] == []
  end

  test "accepts current stateless metadata when body and header versions agree", %{
    conn: conn,
    token: token
  } do
    response =
      conn
      |> mcp_headers(token, "2026-07-28")
      |> put_req_header("mcp-method", "tools/list")
      |> post("/mcp", %{
        "jsonrpc" => "2.0",
        "id" => 4,
        "method" => "tools/list",
        "params" => %{
          "_meta" => %{
            "io.modelcontextprotocol/protocolVersion" => "2026-07-28",
            "io.modelcontextprotocol/clientInfo" => %{"name" => "test", "version" => "1"},
            "io.modelcontextprotocol/clientCapabilities" => %{}
          }
        }
      })
      |> json_response(200)

    assert [%{"name" => "webby"}] = response["result"]["tools"]
  end

  test "rejects missing credentials, hostile origins, and mismatched current versions", context do
    assert context.conn
           |> put_req_header("accept", "application/json, text/event-stream")
           |> post("/mcp", %{
             "jsonrpc" => "2.0",
             "id" => 1,
             "method" => "initialize",
             "params" => %{}
           })
           |> response(401)

    assert build_conn()
           |> mcp_headers(context.token)
           |> put_req_header("origin", "https://evil.example")
           |> post("/mcp", %{
             "jsonrpc" => "2.0",
             "id" => 1,
             "method" => "initialize",
             "params" => %{}
           })
           |> response(403)

    assert build_conn()
           |> mcp_headers(context.token, "2026-07-28")
           |> post("/mcp", %{
             "jsonrpc" => "2.0",
             "id" => 2,
             "method" => "tools/list",
             "params" => %{
               "_meta" => %{"io.modelcontextprotocol/protocolVersion" => "2025-06-18"}
             }
           })
           |> response(400)
  end

  defp mcp_headers(conn, token, version \\ nil) do
    conn =
      conn
      |> put_req_header("accept", "application/json, text/event-stream")
      |> put_req_header("authorization", "Bearer #{token}")

    if version, do: put_req_header(conn, "mcp-protocol-version", version), else: conn
  end
end
