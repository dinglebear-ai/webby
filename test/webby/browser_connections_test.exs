defmodule Webby.BrowserConnectionsTest do
  use ExUnit.Case, async: false

  alias Webby.BrowserConnections

  test "routes a result only through the registered browser channel" do
    browser_id = Ecto.UUID.generate()
    assert :ok = BrowserConnections.register(browser_id, self())

    task =
      Task.async(fn -> BrowserConnections.call(browser_id, %{"tool_name" => "search"}, 500) end)

    assert_receive {:tool_call, %{"call_id" => call_id, "tool_name" => "search"}}

    BrowserConnections.complete(browser_id, %{
      "type" => "tool.result",
      "call_id" => call_id,
      "result" => %{"ok" => true}
    })

    assert Task.await(task) == {:ok, %{"ok" => true}}
  end

  test "times out and asks the exact browser call to cancel" do
    browser_id = Ecto.UUID.generate()
    assert :ok = BrowserConnections.register(browser_id, self())

    task =
      Task.async(fn -> BrowserConnections.call(browser_id, %{"document_id" => "doc"}, 10) end)

    assert_receive {:tool_call, %{"call_id" => call_id}}
    assert Task.await(task) == {:error, "tool_timeout", "The page tool exceeded its time limit"}
    assert_receive {:tool_cancel, %{"call_id" => ^call_id, "document_id" => "doc"}}
  end

  test "cancels by the credential-scoped MCP request identity" do
    browser_id = Ecto.UUID.generate()
    key = {Ecto.UUID.generate(), 12}
    assert :ok = BrowserConnections.register(browser_id, self())

    task =
      Task.async(fn ->
        BrowserConnections.call(browser_id, %{"document_id" => "doc"}, 500, key)
      end)

    assert_receive {:tool_call, %{"call_id" => call_id}}
    assert :ok = BrowserConnections.cancel(key)
    assert Task.await(task) == {:error, "cancelled", "The MCP client cancelled the tool call"}
    assert_receive {:tool_cancel, %{"call_id" => ^call_id}}
  end
end
