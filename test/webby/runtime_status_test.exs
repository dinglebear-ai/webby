defmodule Webby.RuntimeStatusTest do
  use Webby.DataCase, async: false

  test "reports healthy SQLite WAL and non-secret runtime metadata" do
    runtime = fn ->
      %{
        instance_id: "instance-1",
        base_url: "http://127.0.0.1:6477",
        capabilities: %{health: %{status: "available"}, mcp: %{status: "unavailable"}},
        pid: 1234
      }
    end

    assert {:ok, snapshot} = Webby.RuntimeStatus.snapshot(runtime_provider: runtime)
    assert snapshot.service == "webby"
    assert snapshot.status == "ok"
    assert snapshot.database.status == "ok"
    assert snapshot.database.journal_mode == "wal"
    assert snapshot.runtime.capabilities.mcp.status == "unavailable"
    refute Map.has_key?(snapshot.runtime, :credential)
  end

  test "returns a stable degraded snapshot when the database is unavailable" do
    assert {:error, snapshot} =
             Webby.RuntimeStatus.snapshot(
               repo_probe: fn -> {:error, :database_unavailable} end,
               runtime_provider: fn -> %{base_url: "http://127.0.0.1:6477"} end
             )

    assert snapshot.status == "error"
    assert snapshot.database.kind == "database_unavailable"
  end

  test "bounds a stalled database probe" do
    previous = Application.get_env(:webby, :database_probe_timeout)
    Application.put_env(:webby, :database_probe_timeout, 25)

    on_exit(fn ->
      if previous do
        Application.put_env(:webby, :database_probe_timeout, previous)
      else
        Application.delete_env(:webby, :database_probe_timeout)
      end
    end)

    started = System.monotonic_time(:millisecond)

    assert {:error, snapshot} =
             Webby.RuntimeStatus.snapshot(
               repo_probe: fn -> Process.sleep(:infinity) end,
               runtime_provider: fn -> %{base_url: "http://127.0.0.1:6477"} end
             )

    assert System.monotonic_time(:millisecond) - started < 500
    assert snapshot.database.kind == "database_unavailable"
  end
end
