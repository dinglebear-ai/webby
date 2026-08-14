defmodule Webby.Repo.Migrations.AddInvocationAudits do
  use Ecto.Migration

  def change do
    create table(:invocation_audits, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :credential_id, references(:mcp_credentials, type: :binary_id, on_delete: :nilify_all)

      add :registration_id,
          references(:page_registrations, type: :binary_id, on_delete: :nilify_all)

      add :session_id, references(:document_sessions, type: :binary_id, on_delete: :nilify_all)
      add :browser_id, references(:browsers, type: :binary_id, on_delete: :nilify_all)
      add :tool_name, :string, null: false
      add :catalog_revision, :integer, null: false
      add :outcome, :string, null: false
      add :error_kind, :string
      add :duration_ms, :integer, null: false
      timestamps(type: :utc_datetime, updated_at: false)
    end

    create index(:invocation_audits, [:inserted_at])
    create index(:invocation_audits, [:registration_id, :inserted_at])
  end
end
