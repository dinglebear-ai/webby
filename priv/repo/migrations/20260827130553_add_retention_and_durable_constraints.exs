defmodule Webby.Repo.Migrations.AddRetentionAndDurableConstraints do
  use Ecto.Migration

  def change do
    create index(:discoveries, [:updated_at])
    create index(:document_sessions, [:updated_at])
    create index(:browser_pairing_requests, [:updated_at])
    create index(:invocation_audits, [:outcome, :inserted_at])

    durable_check(
      "discoveries",
      "valid_discovery_numbers",
      "NEW.state NOT IN ('discovered', 'ignored', 'registered') OR NEW.tool_count <= 0 OR NEW.tool_count > 64 OR NEW.detection_count <= 0"
    )

    durable_check(
      "document_sessions",
      "valid_document_session_numbers",
      "NEW.status NOT IN ('active', 'replaced', 'closed') OR NEW.tab_id < 0 OR NEW.catalog_revision <= 0"
    )

    durable_check(
      "invocation_audits",
      "valid_invocation_audit_values",
      "NEW.outcome NOT IN ('started', 'succeeded', 'failed', 'abandoned') OR NEW.catalog_revision <= 0 OR NEW.duration_ms < 0"
    )
  end

  # SQLite cannot add a CHECK constraint to an existing table. Equivalent
  # named BEFORE triggers preserve the invariant for both INSERT and UPDATE
  # without rebuilding tables that participate in foreign-key graphs.
  defp durable_check(table, name, invalid_expression) do
    Enum.each(["insert", "update"], fn operation ->
      trigger = "#{name}_#{operation}"

      execute(
        "CREATE TRIGGER #{trigger} BEFORE #{String.upcase(operation)} ON #{table} " <>
          "WHEN #{invalid_expression} BEGIN SELECT RAISE(ABORT, '#{name}'); END",
        "DROP TRIGGER #{trigger}"
      )
    end)
  end
end
