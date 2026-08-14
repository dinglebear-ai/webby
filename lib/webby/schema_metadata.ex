defmodule Webby.SchemaMetadata do
  @moduledoc false

  use GenServer
  require Logger

  alias Ecto.Adapters.SQL

  def start_link(_opts), do: GenServer.start_link(__MODULE__, :ok, name: __MODULE__)

  @impl true
  def init(:ok) do
    now = DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_naive()

    case SQL.query(
           Webby.Repo,
           """
           INSERT INTO webby_meta (key, value, inserted_at, updated_at)
           VALUES ('schema_generation', '4', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = '4', updated_at = excluded.updated_at
           WHERE webby_meta.value IN ('1', '2', '3')
           """,
           [now, now]
         ) do
      {:ok, _result} ->
        validate_generation()

      {:error, reason} ->
        Logger.error("schema generation upsert failed", reason: inspect(reason))
        {:stop, {:schema_metadata_failed, reason}}
    end
  end

  @doc false
  def validate_generation do
    case SQL.query(Webby.Repo, "SELECT value FROM webby_meta WHERE key = 'schema_generation'", []) do
      {:ok, %{rows: [["4"]]}} ->
        {:ok, %{}}

      {:ok, %{rows: [[generation]]}} ->
        Logger.error("unsupported schema generation", reason: generation)
        {:stop, {:unsupported_schema_generation, generation}}

      {:error, reason} ->
        Logger.error("schema generation validation failed", reason: inspect(reason))
        {:stop, {:schema_metadata_failed, reason}}
    end
  end
end
