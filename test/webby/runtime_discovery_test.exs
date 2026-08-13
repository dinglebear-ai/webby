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
    assert Webby.RuntimeDiscovery.snapshot(pid).instance_id == "instance-1"
    assert Path.wildcard(runtime_path <> ".tmp.*") == []

    ref = Process.monitor(pid)
    GenServer.stop(pid)
    assert_receive {:DOWN, ^ref, :process, ^pid, :normal}
    refute File.exists?(runtime_path)

    File.rm_rf!(root)
  end

  test "cleanup is idempotent" do
    root = Path.join(System.tmp_dir!(), "webby-cleanup-#{System.unique_integer([:positive])}")
    runtime_path = Path.join(root, "runtime.json")

    File.mkdir_p!(root)
    File.write!(runtime_path, "{}")

    assert :ok = Webby.RuntimeDiscovery.cleanup(runtime_path)
    refute File.exists?(runtime_path)
    assert :ok = Webby.RuntimeDiscovery.cleanup(runtime_path)

    File.rm_rf!(root)
  end
end
