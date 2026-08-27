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
    assert "page.call" in schema["properties"]["action"]["enum"]

    branches = Map.new(schema["oneOf"], &{&1["properties"]["action"]["const"], &1})

    assert Map.keys(branches) |> Enum.sort() ==
             ~w(browser.list discovery.get discovery.list page.call page.get page.list page.tools status)

    for action <- ~w(status browser.list discovery.list page.list) do
      assert branches[action]["properties"]["params"]["maxProperties"] == 0
      refute "params" in Map.get(branches[action], "required", [])
    end

    for action <- ~w(page.get page.tools) do
      assert branches[action]["required"] == ["params"]
      assert branches[action]["properties"]["params"]["required"] == ["page"]
      assert branches[action]["properties"]["params"]["additionalProperties"] == false
    end

    assert branches["discovery.get"]["properties"]["params"]["required"] == ["id"]

    page_call = branches["page.call"]

    assert page_call["properties"]["params"]["required"] == [
             "page",
             "tool",
             "catalog_revision"
           ]

    assert page_call["properties"]["params"]["properties"]["arguments"]["type"] == "object"
    assert response["result"]["instructions"] =~ "page.list"
    assert response["result"]["instructions"] =~ "catalog_revision"
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

  test "requires an explicit call scope for page invocation", %{conn: conn, token: token} do
    request = %{
      "jsonrpc" => "2.0",
      "id" => 9,
      "method" => "tools/call",
      "params" => %{
        "name" => "webby",
        "arguments" => %{
          "action" => "page.call",
          "params" => %{"page" => "example", "tool" => "find", "catalog_revision" => 1}
        }
      }
    }

    assert conn |> mcp_headers(token, "2025-06-18") |> post("/mcp", request) |> response(403)

    {:ok, _credential, call_token} = Credentials.create("Call client", ["read", "call"])

    response =
      build_conn()
      |> mcp_headers(call_token, "2025-06-18")
      |> post("/mcp", request)
      |> json_response(200)

    assert response["result"]["isError"]
    assert response["result"]["structuredContent"]["kind"] == "not_found"
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
