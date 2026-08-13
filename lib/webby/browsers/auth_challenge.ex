defmodule Webby.Browsers.AuthChallenge do
  use Ecto.Schema
  import Ecto.Changeset
  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "browser_auth_challenges" do
    field :nonce, :binary
    field :instance_id, :string
    field :expires_at, :utc_datetime
    field :used_at, :utc_datetime
    belongs_to :browser, Webby.Browsers.Browser
    timestamps(type: :utc_datetime, updated_at: false)
  end

  def changeset(challenge, attrs) do
    challenge
    |> cast(attrs, [:browser_id, :nonce, :instance_id, :expires_at, :used_at])
    |> validate_required([:browser_id, :nonce, :instance_id, :expires_at])
    |> unique_constraint(:nonce)
  end
end
