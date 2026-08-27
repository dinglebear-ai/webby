telemetry_path = System.fetch_env!("WEBBY_E2E_TELEMETRY_PATH")
capability_hash = System.fetch_env!("WEBBY_E2E_TELEMETRY_CAPABILITY_HASH")
instance_nonce = System.fetch_env!("WEBBY_E2E_INSTANCE_NONCE")
bound_port_path = System.fetch_env!("WEBBY_E2E_BOUND_PORT_FILE")

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
