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

  test "startup refuses to downgrade a newer schema generation" do
    assert {:ok, _result} =
             SQL.query(
               Webby.Repo,
               "UPDATE webby_meta SET value = '2' WHERE key = 'schema_generation'",
               []
             )

    assert {:stop, {:unsupported_schema_generation, "2"}} =
             Webby.SchemaMetadata.validate_generation()

    assert {:ok, %{rows: [["2"]]}} =
             SQL.query(
               Webby.Repo,
               "SELECT value FROM webby_meta WHERE key = 'schema_generation'",
               []
             )

    assert {:ok, _result} =
             SQL.query(
               Webby.Repo,
               "UPDATE webby_meta SET value = '1' WHERE key = 'schema_generation'",
               []
             )
  end
end
