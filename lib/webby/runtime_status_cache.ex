defmodule Webby.RuntimeStatusCache do
  @moduledoc false

  use GenServer

  @refresh_interval :timer.seconds(5)

  def start_link(opts),
    do: GenServer.start_link(__MODULE__, opts, name: opts[:name] || __MODULE__)

  def snapshot(server \\ __MODULE__), do: GenServer.call(server, :snapshot)

  @impl true
  def init(opts) do
    refresh = opts[:refresh] || fn -> Webby.RuntimeStatus.snapshot([]) end
    state = %{snapshot: refresh.(), refresh: refresh}
    schedule_refresh()
    {:ok, state}
  end

  @impl true
  def handle_call(:snapshot, _from, state), do: {:reply, state.snapshot, state}

  @impl true
  def handle_info(:refresh, state) do
    schedule_refresh()
    {:noreply, %{state | snapshot: state.refresh.()}}
  end

  defp schedule_refresh, do: Process.send_after(self(), :refresh, @refresh_interval)
end
