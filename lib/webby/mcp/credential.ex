defmodule Webby.MCP.Credential do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  schema "mcp_credentials" do
    field :display_name, :string
    field :token_hash, :binary
    field :scopes, :map
    field :last_used_at, :utc_datetime
    field :revoked_at, :utc_datetime
    timestamps(type: :utc_datetime)
  end

  def changeset(credential, attrs) do
    credential
    |> cast(attrs, [:display_name, :token_hash, :scopes, :last_used_at, :revoked_at])
    |> validate_required([:display_name, :token_hash, :scopes])
    |> validate_length(:display_name, min: 1, max: 120)
    |> unique_constraint(:token_hash)
  end
end
