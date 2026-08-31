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
    assert {:ok, barrier_token} = BrowserConnections.begin_credential_revocation(credential_id)
    assert is_reference(barrier_token)

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

    assert :ok =
             BrowserConnections.finish_credential_revocation(
               credential_id,
               barrier_token,
               :aborted
             )
  end

  test "browser erasure cancels calls and disconnects the owned channel" do
    browser_id = Ecto.UUID.generate()
    assert :ok = BrowserConnections.register(browser_id, self())

    task = Task.async(fn -> BrowserConnections.call(browser_id, %{}, 500) end)
    assert_receive {:tool_call, %{"call_id" => call_id}}
    assert {:ok, erasure_token} = BrowserConnections.begin_browser_erasure(browser_id)

    assert {:error, "browser_erased", _message} =
             BrowserConnections.call(browser_id, %{"late" => true}, 100)

    refute_receive {:tool_call, %{"late" => true}}

    assert :ok =
             BrowserConnections.finish_browser_erasure(browser_id, erasure_token, :committed)

    assert_receive :browser_erased
    assert_receive {:tool_cancel, %{"call_id" => ^call_id}}

    assert {:error, "browser_erased", _message} = Task.await(task)
    assert {:error, "browser_erased", _message} = BrowserConnections.call(browser_id, %{}, 100)
  end

  test "a committed browser erasure cannot be undone by another owner aborting" do
    browser_id = Ecto.UUID.generate()
    assert {:ok, committing_owner} = BrowserConnections.begin_browser_erasure(browser_id)
    assert {:ok, aborting_owner} = BrowserConnections.begin_browser_erasure(browser_id)

    assert :ok =
             BrowserConnections.finish_browser_erasure(browser_id, committing_owner, :committed)

    assert :ok =
             BrowserConnections.finish_browser_erasure(browser_id, aborting_owner, :aborted)

    assert {:error, :browser_erased} = BrowserConnections.browser_admissible?(browser_id)
    assert {:error, :browser_erased} = BrowserConnections.register(browser_id, self())
  end

  test "an abort keeps the erasure barrier while another owner is active" do
    browser_id = Ecto.UUID.generate()
    assert {:ok, first_owner} = BrowserConnections.begin_browser_erasure(browser_id)
    assert {:ok, second_owner} = BrowserConnections.begin_browser_erasure(browser_id)

    assert :ok = BrowserConnections.finish_browser_erasure(browser_id, first_owner, :aborted)
    assert {:error, :browser_erased} = BrowserConnections.browser_admissible?(browser_id)

    assert :ok = BrowserConnections.finish_browser_erasure(browser_id, second_owner, :aborted)
    assert :ok = BrowserConnections.browser_admissible?(browser_id)
  end

  test "only a browser erasure owner can finish its operation" do
    browser_id = Ecto.UUID.generate()
    assert {:ok, owner} = BrowserConnections.begin_browser_erasure(browser_id)

    assert {:error, :not_erasure_owner} =
             BrowserConnections.finish_browser_erasure(browser_id, make_ref(), :aborted)

    assert {:error, :browser_erased} = BrowserConnections.browser_admissible?(browser_id)
    assert :ok = BrowserConnections.finish_browser_erasure(browser_id, owner, :aborted)
    assert :ok = BrowserConnections.browser_admissible?(browser_id)
  end

  test "browser erasure barriers release dead owners without releasing live owners" do
    browser_id = Ecto.UUID.generate()
    parent = self()

    Application.put_env(:webby, :browser_erasure_reconciler, fn _id -> false end)

    on_exit(fn ->
      Application.delete_env(:webby, :browser_erasure_reconciler)
    end)

    dead_owner =
      spawn(fn ->
        assert {:ok, token} = BrowserConnections.begin_browser_erasure(browser_id)
        send(parent, {:dead_erasure_owner_ready, token})
        receive do: (:stop -> :ok)
      end)

    assert_receive {:dead_erasure_owner_ready, dead_token}
    assert {:ok, live_token} = BrowserConnections.begin_browser_erasure(browser_id)

    process_barrier_down(:browser, browser_id, dead_token, dead_owner)

    assert {:error, :browser_erased} = BrowserConnections.browser_admissible?(browser_id)
    assert %{owners: owners} = :sys.get_state(BrowserConnections).browser_erasures[browser_id]
    refute Map.has_key?(owners, dead_token)
    assert Map.has_key?(owners, live_token)
    assert :ok = BrowserConnections.finish_browser_erasure(browser_id, live_token, :aborted)
    assert :ok = BrowserConnections.browser_admissible?(browser_id)
    Process.exit(dead_owner, :kill)
  end

  test "credential revocation barriers release when their owner dies" do
    browser_id = Ecto.UUID.generate()
    credential_id = Ecto.UUID.generate()
    parent = self()
    Application.put_env(:webby, :credential_revocation_reconciler, fn _id -> false end)

    on_exit(fn ->
      Application.delete_env(:webby, :credential_revocation_reconciler)
    end)

    assert :ok = BrowserConnections.register(browser_id, self())

    owner =
      spawn(fn ->
        assert {:ok, token} = BrowserConnections.begin_credential_revocation(credential_id)
        send(parent, {:credential_owner_ready, token})
        receive do: (:stop -> :ok)
      end)

    assert_receive {:credential_owner_ready, token}

    assert {:error, "revoked", _message} =
             BrowserConnections.call(browser_id, %{}, 100, nil, nil, credential_id)

    process_barrier_down(:credential, credential_id, token, owner)

    call =
      Task.async(fn -> BrowserConnections.call(browser_id, %{}, 500, nil, nil, credential_id) end)

    assert_receive {:tool_call, %{"call_id" => call_id}}

    BrowserConnections.complete(browser_id, %{
      "type" => "tool.result",
      "call_id" => call_id,
      "result" => :ok
    })

    assert {:ok, :ok} = Task.await(call)
    Process.exit(owner, :kill)
  end

  test "stale credential reconciliation retries cannot cross an active owner" do
    credential_id = Ecto.UUID.generate()
    parent = self()

    Application.put_env(:webby, :credential_revocation_reconciler, fn _id ->
      send(parent, :credential_reconciled)
      false
    end)

    on_exit(fn -> Application.delete_env(:webby, :credential_revocation_reconciler) end)

    assert {:ok, first_token} = BrowserConnections.begin_credential_revocation(credential_id)
    generation = barrier_generation(:credential, credential_id)
    assert :ok = BrowserConnections.reconcile_owner_down(:credential, credential_id, first_token)
    assert_receive :credential_reconciled

    assert {:ok, live_token} = BrowserConnections.begin_credential_revocation(credential_id)
    send(BrowserConnections, {:reconcile_barrier, :credential, credential_id, generation})
    _ = :sys.get_state(BrowserConnections)
    refute_receive :credential_reconciled

    assert :ok =
             BrowserConnections.finish_credential_revocation(
               credential_id,
               live_token,
               :aborted
             )
  end

  test "stale browser reconciliation retries cannot cross an active owner" do
    browser_id = Ecto.UUID.generate()
    parent = self()

    Application.put_env(:webby, :browser_erasure_reconciler, fn _id ->
      send(parent, :browser_reconciled)
      false
    end)

    on_exit(fn -> Application.delete_env(:webby, :browser_erasure_reconciler) end)

    assert {:ok, first_token} = BrowserConnections.begin_browser_erasure(browser_id)
    generation = barrier_generation(:browser, browser_id)
    assert :ok = BrowserConnections.reconcile_owner_down(:browser, browser_id, first_token)
    assert_receive :browser_reconciled

    assert {:ok, live_token} = BrowserConnections.begin_browser_erasure(browser_id)
    send(BrowserConnections, {:reconcile_barrier, :browser, browser_id, generation})
    _ = :sys.get_state(BrowserConnections)
    refute_receive :browser_reconciled

    assert :ok = BrowserConnections.finish_browser_erasure(browser_id, live_token, :aborted)
  end

  test "credential tombstone expiry is renewed until committed owners finish" do
    credential_id = Ecto.UUID.generate()
    Application.put_env(:webby, :barrier_tombstone_ttl_ms, 0)
    on_exit(fn -> Application.delete_env(:webby, :barrier_tombstone_ttl_ms) end)

    assert {:ok, committing_token} =
             BrowserConnections.begin_credential_revocation(credential_id)

    assert {:ok, remaining_token} =
             BrowserConnections.begin_credential_revocation(credential_id)

    generation = barrier_generation(:credential, credential_id)

    assert :ok =
             BrowserConnections.finish_credential_revocation(
               credential_id,
               committing_token,
               :committed
             )

    send(BrowserConnections, {:expire_tombstone, :credential, credential_id, generation})
    _ = :sys.get_state(BrowserConnections)
    assert barrier_present?(:credential, credential_id)

    assert :ok =
             BrowserConnections.finish_credential_revocation(
               credential_id,
               remaining_token,
               :aborted
             )

    send(BrowserConnections, {:expire_tombstone, :credential, credential_id, generation})
    _ = :sys.get_state(BrowserConnections)
    refute barrier_present?(:credential, credential_id)
  end

  test "browser tombstone expiry is renewed until committed owners finish" do
    browser_id = Ecto.UUID.generate()
    Application.put_env(:webby, :barrier_tombstone_ttl_ms, 0)
    on_exit(fn -> Application.delete_env(:webby, :barrier_tombstone_ttl_ms) end)

    assert {:ok, committing_token} = BrowserConnections.begin_browser_erasure(browser_id)
    assert {:ok, remaining_token} = BrowserConnections.begin_browser_erasure(browser_id)
    generation = barrier_generation(:browser, browser_id)

    assert :ok =
             BrowserConnections.finish_browser_erasure(browser_id, committing_token, :committed)

    send(BrowserConnections, {:expire_tombstone, :browser, browser_id, generation})
    _ = :sys.get_state(BrowserConnections)
    assert barrier_present?(:browser, browser_id)

    assert :ok = BrowserConnections.finish_browser_erasure(browser_id, remaining_token, :aborted)
    send(BrowserConnections, {:expire_tombstone, :browser, browser_id, generation})
    _ = :sys.get_state(BrowserConnections)
    refute barrier_present?(:browser, browser_id)
  end

  defp process_barrier_down(kind, id, token, owner) do
    assert :ok = BrowserConnections.reconcile_owner_down(kind, id, token)
    assert is_pid(owner)
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

  test "caller death completes its audit inline when the audit task cannot launch" do
    browser_id = Ecto.UUID.generate()
    audit_id = Ecto.UUID.generate()
    parent = self()

    Application.put_env(:webby, :caller_down_audit_starter, fn _operation ->
      {:error, :supervisor_unavailable}
    end)

    Application.put_env(:webby, :caller_down_audit_completion, fn id, outcome, kind, duration ->
      send(parent, {:audit_completed, id, outcome, kind, duration})
      {:ok, 1}
    end)

    on_exit(fn ->
      Application.delete_env(:webby, :caller_down_audit_starter)
      Application.delete_env(:webby, :caller_down_audit_completion)
    end)

    assert :ok = BrowserConnections.register(browser_id, self())

    caller =
      spawn(fn ->
        BrowserConnections.call(browser_id, %{"document_id" => "doc"}, 5_000, nil, audit_id)
      end)

    assert_receive {:tool_call, %{"call_id" => call_id}}
    Process.exit(caller, :kill)
    assert_receive {:audit_completed, ^audit_id, "failed", "caller_down", 0}
    assert_receive {:tool_cancel, %{"call_id" => ^call_id}}
  end

  test "caller death survives every audit launcher failure shape and retries completion" do
    launch_failures = [
      fn _operation -> raise "launch raised" end,
      fn _operation -> throw(:launch_threw) end,
      fn _operation -> exit(:launch_exited) end,
      fn _operation -> :unexpected end
    ]

    Enum.each(launch_failures, fn starter ->
      browser_id = Ecto.UUID.generate()
      audit_id = Ecto.UUID.generate()
      parent = self()
      attempts = :counters.new(1, [])

      Application.put_env(:webby, :caller_down_audit_starter, starter)

      Application.put_env(:webby, :caller_down_audit_completion, fn id, outcome, kind, duration ->
        :counters.add(attempts, 1, 1)
        attempt = :counters.get(attempts, 1)
        send(parent, {:audit_attempt, id, outcome, kind, duration, attempt})
        if attempt == 1, do: {:error, :transient}, else: {:ok, 1}
      end)

      assert :ok = BrowserConnections.register(browser_id, self())

      caller =
        spawn(fn ->
          BrowserConnections.call(browser_id, %{"document_id" => "doc"}, 5_000, nil, audit_id)
        end)

      assert_receive {:tool_call, %{"call_id" => call_id}}
      monitor = Process.monitor(caller)
      Process.exit(caller, :kill)
      assert_receive {:DOWN, ^monitor, :process, ^caller, :killed}
      assert_receive {:audit_attempt, ^audit_id, "failed", "caller_down", 0, 1}
      assert_receive {:audit_attempt, ^audit_id, "failed", "caller_down", 0, 2}
      assert_receive {:tool_cancel, %{"call_id" => ^call_id}}
      assert is_map(:sys.get_state(BrowserConnections))
    end)
  after
    Application.delete_env(:webby, :caller_down_audit_starter)
    Application.delete_env(:webby, :caller_down_audit_completion)
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

  defp barrier_generation(:credential, id),
    do: :sys.get_state(BrowserConnections).credential_barriers[id].generation

  defp barrier_generation(:browser, id),
    do: :sys.get_state(BrowserConnections).browser_erasures[id].generation

  defp barrier_present?(:credential, id),
    do: Map.has_key?(:sys.get_state(BrowserConnections).credential_barriers, id)

  defp barrier_present?(:browser, id),
    do: Map.has_key?(:sys.get_state(BrowserConnections).browser_erasures, id)
end
