defmodule Webby.Browsers.PairingRequest do
  use Ecto.Schema
  import Ecto.Changeset
  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "browser_pairing_requests" do
    field :display_name, :string
    field :extension_id, :string
    field :public_key, :binary
    field :scanning_mode, :string
    field :status, :string, default: "pending"
    field :expires_at, :utc_datetime
    field :resolved_at, :utc_datetime
    belongs_to :browser, Webby.Browsers.Browser
    timestamps(type: :utc_datetime)
  end

  def changeset(request, attrs) do
    request
    |> cast(attrs, [
      :display_name,
      :extension_id,
      :public_key,
      :scanning_mode,
      :status,
      :expires_at,
      :resolved_at
    ])
    |> validate_required([
      :display_name,
      :extension_id,
      :public_key,
      :scanning_mode,
      :status,
      :expires_at
    ])
    |> validate_inclusion(:scanning_mode, ["granted_sites", "all_tabs"])
    |> validate_inclusion(:status, ["pending", "approved", "rejected", "expired"])
    |> validate_length(:display_name, min: 1, max: 80)
    |> validate_length(:extension_id, min: 8, max: 128)
    |> unique_constraint(:extension_id,
      name: :browser_pairing_requests_extension_id_index,
      message: "already has a pending pairing request"
    )
  end
end
