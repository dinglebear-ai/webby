telemetry_path = System.fetch_env!("WEBBY_E2E_TELEMETRY_PATH")
capability_hash = System.fetch_env!("WEBBY_E2E_TELEMETRY_CAPABILITY_HASH")
instance_nonce = System.fetch_env!("WEBBY_E2E_INSTANCE_NONCE")
bound_port_path = System.fetch_env!("WEBBY_E2E_BOUND_PORT_FILE")
world_root = System.fetch_env!("WEBBY_E2E_WORLD_ROOT") |> Path.expand()
health_fault_path = System.fetch_env!("WEBBY_E2E_HEALTH_FAULT_FILE") |> Path.expand()

unless String.starts_with?(health_fault_path, world_root <> "/") do
  raise "health fault flag must remain inside the isolated world"
end

defmodule WebbyE2E.RuntimeStatus do
  @moduledoc false

  def snapshot do
    case active_fault?() do
      true -> degraded_snapshot()
      false -> Webby.RuntimeStatus.snapshot([])
    end
  end

  defp active_fault? do
    path = System.fetch_env!("WEBBY_E2E_HEALTH_FAULT_FILE")
    root = System.fetch_env!("WEBBY_E2E_WORLD_ROOT")
    expected = System.fetch_env!("WEBBY_E2E_INSTANCE_NONCE") <> "\n"

    case {File.lstat(path), File.stat(root)} do
      {{:ok, %File.Stat{type: :regular, mode: mode, uid: uid}}, {:ok, %File.Stat{uid: uid}}} ->
        Bitwise.band(mode, 0o777) == 0o600 and File.read(path) == {:ok, expected}

      {{:error, :enoent}, _root} ->
        false

      _unsafe ->
        true
    end
  end

  defp degraded_snapshot do
    {_status, snapshot} = Webby.RuntimeStatus.snapshot([])

    {:error,
     snapshot
     |> Map.put(:status, "error")
     |> Map.put(:database, %{status: "error", kind: "database_unavailable"})}
  end
end

Application.put_env(:webby, :runtime_status_module, WebbyE2E.RuntimeStatus)
invocation_timeout_ms =
  System.fetch_env!("WEBBY_E2E_INVOCATION_TIMEOUT_MS")
  |> Integer.parse()
  |> case do
    {value, ""} when value in 100..120_000 -> value
    _invalid -> raise "invalid E2E invocation timeout"
  end

Application.put_env(:webby, :invocation_timeout_ms, invocation_timeout_ms)

{:ok, _} = Application.ensure_all_started(:telemetry)

:ok =
  :telemetry.attach(
    "webby-e2e-bound-port-#{instance_nonce}",
    [:thousand_island, :listener, :start],
    fn _event, _measurements, metadata, _config ->
      if metadata.local_address == {127, 0, 0, 1} do
        temporary = bound_port_path <> ".tmp"
        File.write!(temporary, Integer.to_string(metadata.local_port), [:exclusive])
        File.chmod!(temporary, 0o600)
        File.rename!(temporary, bound_port_path)
      end
    end,
    nil
  )

:ok =
  :telemetry.attach(
    "webby-e2e-query-telemetry-#{instance_nonce}",
    [:webby, :repo, :query],
    fn event, measurements, metadata, _config ->
      record = %{
        schema_version: 1,
        capability_hash: capability_hash,
        instance_nonce: instance_nonce,
        event: Enum.map(event, &to_string/1),
        at: DateTime.utc_now() |> DateTime.to_iso8601(),
        measurements:
          Map.take(measurements, [:total_time, :query_time, :queue_time, :decode_time]),
        source: metadata[:source]
      }

      File.write!(telemetry_path, Jason.encode!(record) <> "\n", [:append])
    end,
    nil
  )

{:ok, _} = Application.ensure_all_started(:webby)
Process.sleep(:infinity)
