defmodule Webby.Pages.PageRegistration do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  schema "page_registrations" do
    field :slug, :string
    field :display_name, :string
    field :origin, :string
    field :url_pattern, :string
    belongs_to :preferred_browser, Webby.Browsers.Browser, type: :binary_id
    field :auto_attach, :boolean, default: true
    field :enabled, :boolean, default: true
    field :exposure_mode, :string, default: "broker"
    timestamps(type: :utc_datetime)
  end

  def changeset(registration, attrs) do
    registration
    |> cast(attrs, [
      :slug,
      :display_name,
      :origin,
      :url_pattern,
      :preferred_browser_id,
      :auto_attach,
      :enabled,
      :exposure_mode
    ])
    |> validate_required([
      :slug,
      :display_name,
      :origin,
      :url_pattern,
      :auto_attach,
      :enabled,
      :exposure_mode
    ])
    |> validate_format(:slug, ~r/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    |> validate_length(:slug, max: 80)
    |> validate_length(:display_name, min: 1, max: 120)
    |> validate_length(:origin, max: 2_048)
    |> validate_length(:url_pattern, max: 2_048)
    |> validate_inclusion(:exposure_mode, ["broker", "direct"])
    |> unique_constraint(:slug)
    |> unique_constraint([:origin, :url_pattern], name: :page_registrations_match_identity)
  end
end
