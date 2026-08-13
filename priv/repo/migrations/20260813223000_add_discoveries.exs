defmodule Webby.Repo.Migrations.AddDiscoveries do
  use Ecto.Migration

  def change do
    alter table(:browsers) do
      add :scanning_paused, :boolean, null: false, default: false
    end

    create table(:discoveries, primary_key: false) do
      add :id, :binary_id, primary_key: true

      add :browser_id, references(:browsers, type: :binary_id, on_delete: :delete_all),
        null: false

      add :origin, :string, null: false
      add :sanitized_path, :string, null: false
      add :page_title, :string, null: false
      add :tool_count, :integer, null: false
      add :catalog_fingerprint, :string, null: false
      add :catalog_summary, :map, null: false
      add :first_seen_at, :utc_datetime, null: false
      add :last_seen_at, :utc_datetime, null: false
      add :detection_count, :integer, null: false, default: 1

      add :state, :string,
        null: false,
        default: "discovered",
        check: %{
          name: "valid_discovery_state",
          expr: "state IN ('discovered', 'ignored', 'registered')"
        }

      timestamps(type: :utc_datetime)
    end

    create unique_index(
             :discoveries,
             [:browser_id, :origin, :sanitized_path, :catalog_fingerprint],
             name: :discoveries_observation_identity
           )

    create index(:discoveries, [:state, :last_seen_at])
  end
end
