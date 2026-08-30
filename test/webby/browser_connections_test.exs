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

  test "credential revocation cancels every scoped call and releases each identity" do
    browser_id = Ecto.UUID.generate()
    credential_id = Ecto.UUID.generate()
    assert :ok = BrowserConnections.register(browser_id, self())

    tasks =
      for request_id <- ["first", "second"] do
        Task.async(fn ->
          BrowserConnections.call(browser_id, %{"request_id" => request_id}, 500, {
            credential_id,
            request_id
          })
        end)
      end

    for _ <- tasks, do: assert_receive({:tool_call, %{"call_id" => _}})
    assert 2 = BrowserConnections.cancel_credential(credential_id)

    for task <- tasks,
        do: assert(Task.await(task) == {:error, "revoked", "The MCP credential was revoked"})

    for _ <- tasks, do: assert_receive({:tool_cancel, %{"call_id" => _}})
    assert 0 = BrowserConnections.cancel_credential(credential_id)
  end

  test "failed credential admission never dispatches browser work" do
    browser_id = Ecto.UUID.generate()
    credential_id = Ecto.UUID.generate()
    assert :ok = BrowserConnections.register(browser_id, self())
    assert {:ok, nil} = BrowserConnections.begin_credential_revocation(credential_id)

    assert {:error, "revoked", _message} =
             BrowserConnections.call(
               browser_id,
               %{"tool_name" => "forbidden"},
               100,
               {credential_id, "request"},
               nil,
               credential_id
             )

    refute_receive {:tool_call, _payload}
  end

  test "browser erasure cancels calls and disconnects the owned channel" do
    browser_id = Ecto.UUID.generate()
    assert :ok = BrowserConnections.register(browser_id, self())

    task = Task.async(fn -> BrowserConnections.call(browser_id, %{}, 500) end)
    assert_receive {:tool_call, %{"call_id" => call_id}}
    assert :ok = BrowserConnections.begin_browser_erasure(browser_id)

    assert {:error, "browser_erased", _message} =
             BrowserConnections.call(browser_id, %{"late" => true}, 100)

    refute_receive {:tool_call, %{"late" => true}}
    assert :ok = BrowserConnections.finish_browser_erasure(browser_id, :committed)
    assert_receive :browser_erased
    assert_receive {:tool_cancel, %{"call_id" => ^call_id}}

    assert {:error, "browser_erased", _message} = Task.await(task)
    assert {:error, "browser_erased", _message} = BrowserConnections.call(browser_id, %{}, 100)
  end

  test "rejects duplicate active external keys without disturbing the first call" do
    browser_id = Ecto.UUID.generate()
    key = {Ecto.UUID.generate(), 1}
    assert :ok = BrowserConnections.register(browser_id, self())

    first = Task.async(fn -> BrowserConnections.call(browser_id, %{}, 500, key) end)
    assert_receive {:tool_call, %{"call_id" => call_id}}

    assert {:error, "duplicate_request", _message} =
             BrowserConnections.call(browser_id, %{}, 500, key)

    BrowserConnections.complete(browser_id, %{
      "type" => "tool.result",
      "call_id" => call_id,
      "result" => "first"
    })

    assert Task.await(first) == {:ok, "first"}
  end

  test "enforces a global pending-call cap and releases capacity after cancellation" do
    browser_id = Ecto.UUID.generate()
    assert :ok = BrowserConnections.register(browser_id, self())
    call_timeout = 60_000

    tasks =
      for id <- 1..100 do
        Task.async(fn ->
          BrowserConnections.call(browser_id, %{"sequence" => id}, call_timeout, {browser_id, id})
        end)
      end

    on_exit(fn ->
      Enum.each(1..100, &BrowserConnections.cancel({browser_id, &1}))
      Enum.each(tasks, &Process.exit(&1.pid, :kill))
    end)

    for _ <- 1..100, do: assert_receive({:tool_call, %{"call_id" => _}})

    assert {:error, "server_busy", _message} = BrowserConnections.call(browser_id, %{}, 100)
    assert :ok = BrowserConnections.cancel({browser_id, 1})
    assert_receive {:tool_cancel, %{"sequence" => 1}}

    replacement =
      Task.async(fn -> BrowserConnections.call(browser_id, %{"replacement" => true}, 500) end)

    assert_receive {:tool_call, %{"call_id" => replacement_id, "replacement" => true}}

    BrowserConnections.complete(browser_id, %{
      "type" => "tool.result",
      "call_id" => replacement_id,
      "result" => :ok
    })

    assert Task.await(replacement) == {:ok, :ok}
    Enum.each(2..100, &BrowserConnections.cancel({browser_id, &1}))
    Enum.each(tasks, &Task.await(&1, 5_000))
  end

  test "caller death cancels browser work and releases the external identity" do
    browser_id = Ecto.UUID.generate()
    key = {browser_id, "caller"}
    assert :ok = BrowserConnections.register(browser_id, self())

    caller =
      spawn(fn -> BrowserConnections.call(browser_id, %{"document_id" => "doc"}, 5_000, key) end)

    assert_receive {:tool_call, %{"call_id" => call_id}}
    Process.exit(caller, :kill)
    assert_receive {:tool_cancel, %{"call_id" => ^call_id}}
    _ = :sys.get_state(BrowserConnections)

    replacement = Task.async(fn -> BrowserConnections.call(browser_id, %{}, 500, key) end)
    assert_receive {:tool_call, %{"call_id" => replacement_id}}
    assert :ok = BrowserConnections.cancel(key)

    assert Task.await(replacement) ==
             {:error, "cancelled", "The MCP client cancelled the tool call"}

    assert_receive {:tool_cancel, %{"call_id" => ^replacement_id}}
  end

  test "only the channel process that received a call may complete it" do
    browser_id = Ecto.UUID.generate()
    assert :ok = BrowserConnections.register(browser_id, self())
    task = Task.async(fn -> BrowserConnections.call(browser_id, %{}, 500) end)
    assert_receive {:tool_call, %{"call_id" => call_id}}

    rogue =
      Task.async(fn ->
        BrowserConnections.complete(browser_id, self(), %{
          "type" => "tool.result",
          "call_id" => call_id,
          "result" => "rogue"
        })
      end)

    assert Task.await(rogue) == :ok
    refute Task.yield(task, 20)

    BrowserConnections.complete(browser_id, %{
      "type" => "tool.result",
      "call_id" => call_id,
      "result" => "current"
    })

    assert Task.await(task) == {:ok, "current"}
  end
end
