defmodule Webby.RetentionWorker do
  @moduledoc false
  use GenServer

  require Logger

  @max_batches_per_cycle 10

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @impl true
  def init(opts) do
    state = Keyword.merge(Application.get_env(:webby, :retention, []), opts)
    send(self(), {:maintain, @max_batches_per_cycle})
    {:ok, state}
  end

  @impl true
  def handle_info({:maintain, batches_remaining}, state) do
    maintenance_module = Keyword.get(state, :maintenance_module, Webby.DataRetention)

    case run(maintenance_module, state) do
      {:ok, counts} ->
        if full_batch?(counts, Keyword.fetch!(state, :batch_size)) do
          continue_maintenance(batches_remaining)
        else
          schedule_next(state)
        end

      _result ->
        schedule_next(state)
    end

    {:noreply, state}
  end

  defp continue_maintenance(batches_remaining) when batches_remaining > 1,
    do: send(self(), {:maintain, batches_remaining - 1})

  defp continue_maintenance(_batches_remaining),
    do: Process.send_after(self(), {:maintain, @max_batches_per_cycle}, 1)

  defp schedule_next(state) do
    Process.send_after(
      self(),
      {:maintain, @max_batches_per_cycle},
      Keyword.fetch!(state, :interval_ms)
    )
  end

  defp full_batch?(counts, batch_size) when is_map(counts) do
    Enum.any?(counts, fn {_category, count} -> is_integer(count) and count >= batch_size end)
  end

  defp full_batch?(_counts, _batch_size), do: false

  defp run(maintenance_module, state) do
    case maintenance_module.maintain(state) do
      {:ok, counts} -> {:ok, counts}
      {:error, reason} -> Logger.error("retention maintenance failed", reason: inspect(reason))
    end
  rescue
    exception ->
      Logger.error(
        "retention maintenance crashed stacktrace=#{Exception.format_stacktrace(__STACKTRACE__)}",
        reason: Exception.message(exception)
      )
  end
end
