payload = System.fetch_env!("WEBBY_E2E_PERSISTENCE_OPERATION") |> Jason.decode!()
import Ecto.Query

{:ok, _} = Application.ensure_all_started(:ecto_sql)
{:ok, _} = Application.ensure_all_started(:telemetry)

if payload["op"] == "retention.drain" do
  telemetry_path = System.fetch_env!("WEBBY_E2E_TELEMETRY_PATH")
  capability_hash = System.fetch_env!("WEBBY_E2E_TELEMETRY_CAPABILITY_HASH")
  instance_nonce = System.fetch_env!("WEBBY_E2E_INSTANCE_NONCE")

  :ok =
    :telemetry.attach_many(
      "webby-e2e-retention-probe-#{System.unique_integer([:positive])}",
      [[:webby, :retention, :batch], [:webby, :retention, :drain]],
      fn event, measurements, metadata, _config ->
        record = %{
          schema_version: 1,
          capability_hash: capability_hash,
          instance_nonce: instance_nonce,
          event: Enum.map(event, &to_string/1),
          at: DateTime.utc_now() |> DateTime.to_iso8601(),
          measurements:
            Map.take(measurements, [:batch, :batch_count, :rows_examined, :rows_deleted]),
          metadata: Map.take(metadata, [:batch_size, :counts])
        }

        File.write!(telemetry_path, Jason.encode!(record) <> "\n", [:append])
      end,
      nil
    )
end

{:ok, repo} = Webby.Repo.start_link()

result =
  case payload do
    %{"op" => "retention.drain", "cutoff" => cutoff, "batch_size" => batch_size} ->
      {:ok, cutoff, _offset} = DateTime.from_iso8601(cutoff)

      Webby.DataRetention.drain(
        %{discoveries: cutoff, sessions: cutoff, pairings: cutoff, invocations: cutoff},
        batch_size
      )

    %{"op" => "audit.reconcile", "cutoff" => cutoff} ->
      {:ok, cutoff, _offset} = DateTime.from_iso8601(cutoff)
      Webby.Invocations.reconcile_abandoned(cutoff)

    %{"op" => "browser.erase", "browser_id" => browser_id, "audits" => audits} ->
      policy =
        case audits do
          "anonymize" -> :anonymize
          "delete" -> :delete
          _ -> raise "invalid isolated audit erasure policy"
        end

      Webby.DataRetention.erase_browser(browser_id, audits: policy)

    %{"op" => "schema.validate"} ->
      Webby.SchemaMetadata.validate_generation()

    %{"op" => "audit.complete.retry", "audit_id" => audit_id} ->
      attempt = :counters.new(1, [])

      update = fn id, outcome, error_kind, duration ->
        :counters.add(attempt, 1, 1)

        if :counters.get(attempt, 1) < 3 do
          raise Exqlite.Error, message: "database is locked"
        else
          Webby.Repo.update_all(
            from(a in Webby.InvocationAudit, where: a.id == ^id and a.outcome == "started"),
            set: [outcome: outcome, error_kind: error_kind, duration_ms: duration]
          )
        end
      end

      {Webby.Invocations.complete_audit(audit_id, "failed", "fixture_failure", 7,
         attempts: 3,
         update_fun: update
       ), :counters.get(attempt, 1)}

    %{"op" => "audit.complete.exhausted", "audit_id" => audit_id} ->
      attempt = :counters.new(1, [])

      update = fn _id, _outcome, _error_kind, _duration ->
        :counters.add(attempt, 1, 1)
        raise Exqlite.Error, message: "database is busy"
      end

      {Webby.Invocations.complete_audit(audit_id, "failed", "fixture_failure", 7,
         attempts: 2,
         update_fun: update
       ), :counters.get(attempt, 1)}
  end

IO.puts("WEBBY_E2E_RESULT=" <> inspect(result, limit: :infinity))
GenServer.stop(repo)
