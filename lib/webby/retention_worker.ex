defmodule Webby.RetentionWorker do
  @moduledoc false
  use GenServer

  require Logger

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @impl true
  def init(opts) do
    state = Keyword.merge(Application.get_env(:webby, :retention, []), opts)
    send(self(), :maintain)
    {:ok, state}
  end

  @impl true
  def handle_info(:maintain, state) do
    run(state)
    Process.send_after(self(), :maintain, Keyword.fetch!(state, :interval_ms))
    {:noreply, state}
  end

  defp run(state) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    {:ok, _} =
      Webby.Invocations.reconcile_abandoned(
        DateTime.add(now, -Keyword.fetch!(state, :abandoned_after_seconds), :second)
      )

    cutoffs = %{
      discoveries: cutoff(now, state, :discovery_days),
      sessions: cutoff(now, state, :session_days),
      pairings: cutoff(now, state, :pairing_days),
      invocations: cutoff(now, state, :invocation_days)
    }

    case Webby.DataRetention.prune(cutoffs, Keyword.fetch!(state, :batch_size)) do
      {:ok, _counts} -> :ok
      {:error, reason} -> Logger.error("retention maintenance failed", reason: inspect(reason))
    end
  rescue
    exception ->
      Logger.error("retention maintenance crashed", reason: Exception.message(exception))
  end

  defp cutoff(now, state, key),
    do: DateTime.add(now, -Keyword.fetch!(state, key), :day)
end
