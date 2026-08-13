defmodule Webby.Repo.Migrations.AddBrowserPairing do
  use Ecto.Migration

  def change do
    create table(:browsers, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :display_name, :string, null: false
      add :extension_id, :string, null: false
      add :public_key, :binary, null: false

      add :scanning_mode, :string,
        null: false,
        default: "granted_sites",
        check: %{
          name: "valid_scanning_mode",
          expr: "scanning_mode IN ('granted_sites', 'all_tabs')"
        }

      add :paired_at, :utc_datetime, null: false
      add :last_seen_at, :utc_datetime
      add :revoked_at, :utc_datetime
      timestamps(type: :utc_datetime)
    end

    create unique_index(:browsers, [:extension_id], where: "revoked_at IS NULL")

    create table(:browser_pairing_requests, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :display_name, :string, null: false
      add :extension_id, :string, null: false
      add :public_key, :binary, null: false

      add :scanning_mode, :string,
        null: false,
        check: %{
          name: "valid_pairing_scanning_mode",
          expr: "scanning_mode IN ('granted_sites', 'all_tabs')"
        }

      add :status, :string,
        null: false,
        default: "pending",
        check: %{
          name: "valid_pairing_status",
          expr: "status IN ('pending', 'approved', 'rejected', 'expired')"
        }

      add :expires_at, :utc_datetime, null: false
      add :resolved_at, :utc_datetime
      add :browser_id, references(:browsers, type: :binary_id, on_delete: :nilify_all)
      timestamps(type: :utc_datetime)
    end

    create index(:browser_pairing_requests, [:status, :expires_at])
    create unique_index(:browser_pairing_requests, [:extension_id], where: "status = 'pending'")

    create table(:browser_auth_challenges, primary_key: false) do
      add :id, :binary_id, primary_key: true

      add :browser_id, references(:browsers, type: :binary_id, on_delete: :delete_all),
        null: false

      add :nonce, :binary, null: false
      add :instance_id, :string, null: false
      add :expires_at, :utc_datetime, null: false
      add :used_at, :utc_datetime
      timestamps(type: :utc_datetime, updated_at: false)
    end

    create unique_index(:browser_auth_challenges, [:nonce])
    create index(:browser_auth_challenges, [:browser_id, :expires_at])
  end
end
