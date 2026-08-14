defmodule Webby.Repo.Migrations.AddMcpCredentials do
  use Ecto.Migration

  def change do
    create table(:mcp_credentials, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :display_name, :string, null: false
      add :token_hash, :binary, null: false
      add :scopes, :map, null: false
      add :last_used_at, :utc_datetime
      add :revoked_at, :utc_datetime
      timestamps(type: :utc_datetime)
    end

    create unique_index(:mcp_credentials, [:token_hash])
    create index(:mcp_credentials, [:revoked_at])
  end
end
