defmodule Webby.InvocationAudit do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  schema "invocation_audits" do
    belongs_to :credential, Webby.MCP.Credential, type: :binary_id
    belongs_to :registration, Webby.Pages.PageRegistration, type: :binary_id
    belongs_to :session, Webby.Pages.DocumentSession, type: :binary_id
    belongs_to :browser, Webby.Browsers.Browser, type: :binary_id
    field :tool_name, :string
    field :catalog_revision, :integer
    field :outcome, :string
    field :error_kind, :string
    field :duration_ms, :integer
    timestamps(type: :utc_datetime, updated_at: false)
  end

  def changeset(audit, attrs) do
    audit
    |> cast(attrs, [
      :credential_id,
      :registration_id,
      :session_id,
      :browser_id,
      :tool_name,
      :catalog_revision,
      :outcome,
      :error_kind,
      :duration_ms
    ])
    |> validate_required([
      :registration_id,
      :session_id,
      :browser_id,
      :tool_name,
      :catalog_revision,
      :outcome,
      :duration_ms
    ])
    |> validate_inclusion(:outcome, ["started", "succeeded", "failed"])
  end
end
