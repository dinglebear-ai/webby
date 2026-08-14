defmodule Webby.Repo.Migrations.AddPageRegistrationsAndDocumentSessions do
  use Ecto.Migration

  def change do
    create table(:page_registrations, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :slug, :string, null: false
      add :display_name, :string, null: false
      add :origin, :string, null: false
      add :url_pattern, :string, null: false
      add :preferred_browser_id, references(:browsers, type: :binary_id, on_delete: :nilify_all)
      add :auto_attach, :boolean, null: false, default: true
      add :enabled, :boolean, null: false, default: true

      add :exposure_mode, :string,
        null: false,
        default: "broker",
        check: %{name: "valid_exposure_mode", expr: "exposure_mode IN ('broker', 'direct')"}

      timestamps(type: :utc_datetime)
    end

    create unique_index(:page_registrations, [:slug])

    create unique_index(:page_registrations, [:origin, :url_pattern],
             name: :page_registrations_match_identity
           )

    create index(:page_registrations, [:origin, :enabled])

    create table(:document_sessions, primary_key: false) do
      add :id, :binary_id, primary_key: true

      add :browser_id, references(:browsers, type: :binary_id, on_delete: :delete_all),
        null: false

      add :registration_id,
          references(:page_registrations, type: :binary_id, on_delete: :nilify_all)

      add :tab_id, :integer, null: false
      add :document_id, :string, null: false
      add :current_origin, :string, null: false
      add :sanitized_path, :string, null: false
      add :page_title, :string, null: false
      add :catalog_revision, :integer, null: false, default: 1
      add :catalog_fingerprint, :string, null: false
      add :catalog_summary, :map, null: false
      add :connected_at, :utc_datetime, null: false
      add :last_seen_at, :utc_datetime, null: false

      add :status, :string,
        null: false,
        default: "active",
        check: %{
          name: "valid_document_session_status",
          expr: "status IN ('active', 'replaced', 'closed')"
        }

      timestamps(type: :utc_datetime)
    end

    create unique_index(:document_sessions, [:browser_id, :tab_id, :document_id],
             name: :document_sessions_tab_identity
           )

    create index(:document_sessions, [:registration_id, :status, :last_seen_at])
  end
end
