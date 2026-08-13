defmodule Webby.Discovery.Discovery do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}

  schema "discoveries" do
    belongs_to :browser, Webby.Browsers.Browser, type: :binary_id
    field :origin, :string
    field :sanitized_path, :string
    field :page_title, :string
    field :tool_count, :integer
    field :catalog_fingerprint, :string
    field :catalog_summary, :map
    field :first_seen_at, :utc_datetime
    field :last_seen_at, :utc_datetime
    field :detection_count, :integer, default: 1
    field :state, :string, default: "discovered"
    timestamps(type: :utc_datetime)
  end

  def changeset(discovery, attrs) do
    discovery
    |> cast(attrs, [
      :browser_id,
      :origin,
      :sanitized_path,
      :page_title,
      :tool_count,
      :catalog_fingerprint,
      :catalog_summary,
      :first_seen_at,
      :last_seen_at,
      :detection_count,
      :state
    ])
    |> validate_required([
      :browser_id,
      :origin,
      :sanitized_path,
      :page_title,
      :tool_count,
      :catalog_fingerprint,
      :catalog_summary,
      :first_seen_at,
      :last_seen_at
    ])
    |> validate_inclusion(:state, ["discovered", "ignored", "registered"])
    |> validate_number(:tool_count, greater_than: 0, less_than_or_equal_to: 64)
    |> validate_number(:detection_count, greater_than: 0)
    |> validate_length(:origin, max: 2_048)
    |> validate_length(:sanitized_path, max: 2_048)
    |> validate_length(:page_title, max: 200)
    |> validate_length(:catalog_fingerprint, is: 64)
    |> unique_constraint(:catalog_fingerprint, name: :discoveries_observation_identity)
  end
end
