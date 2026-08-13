defmodule Webby.SchemaMetadata do
  @moduledoc false

  use GenServer

  alias Ecto.Adapters.SQL

  def start_link(_opts), do: GenServer.start_link(__MODULE__, :ok, name: __MODULE__)

  @impl true
  def init(:ok) do
    now = DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_naive()

    {:ok, _result} =
      SQL.query(
        Webby.Repo,
        """
        INSERT INTO webby_meta (key, value, inserted_at, updated_at)
        VALUES ('schema_generation', '1', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        """,
        [now, now]
      )

    {:ok, %{}}
  end
end
