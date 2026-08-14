defmodule Webby.Pages.DocumentSession do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  schema "document_sessions" do
    belongs_to :browser, Webby.Browsers.Browser, type: :binary_id
    belongs_to :registration, Webby.Pages.PageRegistration, type: :binary_id
    field :tab_id, :integer
    field :document_id, :string
    field :current_origin, :string
    field :sanitized_path, :string
    field :page_title, :string
    field :catalog_revision, :integer, default: 1
    field :catalog_fingerprint, :string
    field :catalog_summary, :map
    field :connected_at, :utc_datetime
    field :last_seen_at, :utc_datetime
    field :status, :string, default: "active"
    timestamps(type: :utc_datetime)
  end

  def changeset(session, attrs) do
    session
    |> cast(attrs, [
      :browser_id,
      :registration_id,
      :tab_id,
      :document_id,
      :current_origin,
      :sanitized_path,
      :page_title,
      :catalog_revision,
      :catalog_fingerprint,
      :catalog_summary,
      :connected_at,
      :last_seen_at,
      :status
    ])
    |> validate_required([
      :browser_id,
      :registration_id,
      :tab_id,
      :document_id,
      :current_origin,
      :sanitized_path,
      :page_title,
      :catalog_revision,
      :catalog_fingerprint,
      :catalog_summary,
      :connected_at,
      :last_seen_at,
      :status
    ])
    |> validate_number(:tab_id, greater_than_or_equal_to: 0)
    |> validate_number(:catalog_revision, greater_than: 0)
    |> validate_inclusion(:status, ["active", "replaced", "closed"])
    |> unique_constraint([:browser_id, :tab_id, :document_id],
      name: :document_sessions_tab_identity
    )
  end
end
