defmodule Webby.Browsers.Browser do
  use Ecto.Schema
  import Ecto.Changeset
  @primary_key {:id, :binary_id, autogenerate: true}

  schema "browsers" do
    field :display_name, :string
    field :extension_id, :string
    field :public_key, :binary
    field :scanning_mode, :string
    field :paired_at, :utc_datetime
    field :last_seen_at, :utc_datetime
    field :revoked_at, :utc_datetime
    timestamps(type: :utc_datetime)
  end

  def changeset(browser, attrs) do
    browser
    |> cast(attrs, [
      :display_name,
      :extension_id,
      :public_key,
      :scanning_mode,
      :paired_at,
      :last_seen_at,
      :revoked_at
    ])
    |> validate_required([:display_name, :extension_id, :public_key, :scanning_mode, :paired_at])
    |> validate_inclusion(:scanning_mode, ["granted_sites", "all_tabs"])
    |> validate_length(:display_name, min: 1, max: 80)
    |> validate_length(:extension_id, min: 8, max: 128)
    |> unique_constraint(:extension_id)
  end
end
