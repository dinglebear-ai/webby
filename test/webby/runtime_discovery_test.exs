defmodule Webby.RuntimeDiscoveryTest do
  use ExUnit.Case, async: true

  import Bitwise

  test "atomically publishes owner-only runtime metadata and removes it on shutdown" do
    root = Path.join(System.tmp_dir!(), "webby-runtime-#{System.unique_integer([:positive])}")
    runtime_path = Path.join(root, "runtime.json")
    authority_port = free_port()

    metadata = fn ->
      %{
        instance_id: "instance-1",
        base_url: "http://127.0.0.1:6477",
        capabilities: %{
          health: %{status: "available", url: "http://127.0.0.1:6477/health"},
          mcp: %{status: "unavailable"}
        },
        pid: 1234
      }
    end

    pid =
      start_supervised!(
        {Webby.RuntimeDiscovery,
         path: runtime_path, metadata: metadata, authority_port: authority_port}
      )

    assert Jason.decode!(File.read!(runtime_path)) == %{
             "instance_id" => "instance-1",
             "base_url" => "http://127.0.0.1:6477",
             "capabilities" => %{
               "health" => %{
                 "status" => "available",
                 "url" => "http://127.0.0.1:6477/health"
               },
               "mcp" => %{"status" => "unavailable"}
             },
             "pid" => 1234,
             "publication_id" => Webby.RuntimeDiscovery.snapshot(pid).publication_id
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

  test "a second publisher cannot replace the authoritative runtime metadata" do
    root = Path.join(System.tmp_dir!(), "webby-successor-#{System.unique_integer([:positive])}")
    runtime_path = Path.join(root, "runtime.json")
    authority_port = free_port()

    {:ok, first} =
      Webby.RuntimeDiscovery.start_link(
        path: runtime_path,
        name: :first_owner,
        authority_port: authority_port,
        metadata: fn -> %{instance_id: "first"} end
      )

    original = File.read!(runtime_path)
    previous_trap = Process.flag(:trap_exit, true)
    on_exit(fn -> Process.flag(:trap_exit, previous_trap) end)

    assert {:error, {:already_running, ^authority_port}} =
             Webby.RuntimeDiscovery.start_link(
               path: runtime_path,
               name: :second_owner,
               authority_port: authority_port,
               metadata: fn -> %{instance_id: "second"} end
             )

    assert File.read!(runtime_path) == original
    assert Webby.RuntimeDiscovery.snapshot(first).instance_id == "first"
    GenServer.stop(first)
    File.rm_rf!(root)
  end

  defp free_port do
    {:ok, socket} = :gen_tcp.listen(0, [:binary, ip: {127, 0, 0, 1}, active: false])
    {:ok, port} = :inet.port(socket)
    :ok = :gen_tcp.close(socket)
    port
  end
end
