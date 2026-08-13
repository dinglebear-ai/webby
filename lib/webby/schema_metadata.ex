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
           VALUES ('schema_generation', '1', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
           """,
           [now, now]
         ) do
      {:ok, _result} ->
        {:ok, %{}}

      {:error, reason} ->
        Logger.error("schema generation upsert failed", reason: inspect(reason))
        {:stop, {:schema_metadata_failed, reason}}
    end
  end
end
