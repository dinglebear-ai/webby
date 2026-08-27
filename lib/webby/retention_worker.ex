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
    run(Keyword.get(state, :maintenance_module, Webby.DataRetention), state)
    Process.send_after(self(), :maintain, Keyword.fetch!(state, :interval_ms))
    {:noreply, state}
  end

  defp run(maintenance_module, state) do
    case maintenance_module.maintain(state) do
      {:ok, _counts} -> :ok
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
