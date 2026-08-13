defmodule Webby.RuntimeDiscoveryTest do
  use ExUnit.Case, async: true

  import Bitwise

  test "atomically publishes owner-only runtime metadata and removes it on shutdown" do
    root = Path.join(System.tmp_dir!(), "webby-runtime-#{System.unique_integer([:positive])}")
    runtime_path = Path.join(root, "runtime.json")

    metadata = fn ->
      %{
        instance_id: "instance-1",
        base_url: "http://127.0.0.1:6477",
        mcp_url: "http://127.0.0.1:6477/mcp",
        pid: 1234
      }
    end

    pid = start_supervised!({Webby.RuntimeDiscovery, path: runtime_path, metadata: metadata})

    assert Jason.decode!(File.read!(runtime_path)) == %{
             "instance_id" => "instance-1",
             "base_url" => "http://127.0.0.1:6477",
             "mcp_url" => "http://127.0.0.1:6477/mcp",
             "pid" => 1234
           }

    assert band(File.stat!(runtime_path).mode, 0o777) == 0o600
    assert band(File.stat!(root).mode, 0o777) == 0o700
    assert Webby.RuntimeDiscovery.snapshot(pid).instance_id == "instance-1"
    assert Path.wildcard(runtime_path <> ".tmp.*") == []

    ref = Process.monitor(pid)
    GenServer.stop(pid)
    assert_receive {:DOWN, ^ref, :process, ^pid, :normal}
    refute File.exists?(runtime_path)

    File.rm_rf!(root)
  end

  test "a second publisher cannot replace a live runtime file" do
    root = Path.join(System.tmp_dir!(), "webby-cleanup-#{System.unique_integer([:positive])}")
    runtime_path = Path.join(root, "runtime.json")

    metadata = fn -> %{instance_id: "old", base_url: "old", mcp_url: "old", pid: 1} end
    pid = start_supervised!({Webby.RuntimeDiscovery, path: runtime_path, metadata: metadata})
    original = File.read!(runtime_path)
    previous_trap = Process.flag(:trap_exit, true)
    on_exit(fn -> Process.flag(:trap_exit, previous_trap) end)

    assert {:error, {:already_running, _lock_path}} =
             Webby.RuntimeDiscovery.start_link(
               path: runtime_path,
               name: :replacement_discovery,
               metadata: fn -> %{instance_id: "new"} end
             )

    GenServer.stop(pid)
    refute File.exists?(runtime_path)
    refute File.exists?(runtime_path <> ".lock")
    assert original =~ "old"

    File.rm_rf!(root)
  end

  test "instance identity is durable and owner-only" do
    root = Path.join(System.tmp_dir!(), "webby-identity-#{System.unique_integer([:positive])}")
    path = Path.join(root, "instance-id")

    first = Webby.RuntimeDiscovery.instance_id(path)
    second = Webby.RuntimeDiscovery.instance_id(path)

    assert {:ok, _uuid} = Ecto.UUID.cast(first)
    assert second == first
    assert band(File.stat!(path).mode, 0o777) == 0o600

    File.rm_rf!(root)
  end
end
