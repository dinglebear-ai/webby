defmodule Webby.SchemaMetadataTest do
  use Webby.DataCase, async: false

  alias Ecto.Adapters.SQL

  test "startup records the current schema generation" do
    assert {:ok, %{rows: [["1"]]}} =
             SQL.query(
               Webby.Repo,
               "SELECT value FROM webby_meta WHERE key = 'schema_generation'",
               []
             )
  end
end
