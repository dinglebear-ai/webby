defmodule Webby.BrowserConnections do
  @moduledoc "Tracks authenticated browser channels and bounded tool calls."

  use GenServer
  require Logger

  @timeout 15_000

  def start_link(_opts), do: GenServer.start_link(__MODULE__, %{}, name: __MODULE__)

  def register(browser_id, pid \\ self()),
    do: GenServer.call(__MODULE__, {:register, browser_id, pid})

  def call(browser_id, payload, timeout \\ @timeout, external_key \\ nil),
    do:
      GenServer.call(
        __MODULE__,
        {:call, browser_id, payload, timeout, external_key},
        timeout + 1_000
      )

  def cancel(external_key), do: GenServer.call(__MODULE__, {:cancel, external_key})

  def complete(browser_id, payload),
    do: GenServer.cast(__MODULE__, {:complete, browser_id, payload})

  @impl true
  def init(_state), do: {:ok, %{connections: %{}, calls: %{}}}

  @impl true
  def handle_call({:register, browser_id, pid}, _from, state) do
    state = drop_connection(state, browser_id, "browser_replaced")
    monitor = Process.monitor(pid)
    {:reply, :ok, put_in(state, [:connections, browser_id], {pid, monitor})}
  end

  def handle_call({:call, browser_id, payload, timeout, external_key}, from, state) do
    case state.connections[browser_id] do
      {pid, _monitor} ->
        call_id = Ecto.UUID.generate()
        timer = Process.send_after(self(), {:call_timeout, call_id}, timeout)
        send(pid, {:tool_call, Map.put(payload, "call_id", call_id)})

        call = %{
          from: from,
          browser_id: browser_id,
          timer: timer,
          payload: payload,
          external_key: external_key
        }

        {:noreply, put_in(state, [:calls, call_id], call)}

      nil ->
        {:reply, {:error, "browser_offline", "The selected browser is not connected"}, state}
    end
  end

  def handle_call({:cancel, external_key}, _from, state) do
    case Enum.find(state.calls, fn {_id, call} -> call.external_key == external_key end) do
      {call_id, call} ->
        Process.cancel_timer(call.timer)
        send_cancel(state, call_id, call)

        GenServer.reply(
          call.from,
          {:error, "cancelled", "The MCP client cancelled the tool call"}
        )

        {:reply, :ok, update_in(state.calls, &Map.delete(&1, call_id))}

      nil ->
        {:reply, :not_found, state}
    end
  end

  @impl true
  def handle_cast({:complete, browser_id, %{"call_id" => call_id} = payload}, state) do
    case state.calls[call_id] do
      %{browser_id: ^browser_id} = call ->
        Process.cancel_timer(call.timer)
        GenServer.reply(call.from, completion(payload))
        {:noreply, update_in(state.calls, &Map.delete(&1, call_id))}

      _unknown ->
        Logger.warning("ignored unmatched browser tool result",
          event: "browser.tool_result.unmatched",
          browser_id: browser_id,
          call_id: call_id
        )

        {:noreply, state}
    end
  end

  def handle_cast({:complete, _browser_id, _payload}, state), do: {:noreply, state}

  @impl true
  def handle_info({:call_timeout, call_id}, state) do
    case Map.pop(state.calls, call_id) do
      {nil, _calls} ->
        {:noreply, state}

      {call, calls} ->
        send_cancel(state, call_id, call)

        GenServer.reply(
          call.from,
          {:error, "tool_timeout", "The page tool exceeded its time limit"}
        )

        {:noreply, %{state | calls: calls}}
    end
  end

  def handle_info({:DOWN, monitor, :process, _pid, _reason}, state) do
    case Enum.find(state.connections, fn {_id, {_pid, ref}} -> ref == monitor end) do
      {browser_id, _connection} ->
        {:noreply, drop_connection(state, browser_id, "browser_offline")}

      nil ->
        {:noreply, state}
    end
  end

  defp completion(%{"type" => "tool.result", "result" => result}), do: {:ok, result}

  defp completion(%{"type" => "tool.error", "error" => error}) do
    {:error, error["kind"] || "tool_failed", error["message"] || "The page tool failed"}
  end

  defp send_cancel(state, call_id, call) do
    case state.connections[call.browser_id] do
      {pid, _monitor} -> send(pid, {:tool_cancel, Map.put(call.payload, "call_id", call_id)})
      nil -> :ok
    end
  end

  defp drop_connection(state, browser_id, kind) do
    case Map.pop(state.connections, browser_id) do
      {nil, _connections} ->
        state

      {{_pid, monitor}, connections} ->
        Process.demonitor(monitor, [:flush])

        {failed, calls} =
          Enum.split_with(state.calls, fn {_id, call} -> call.browser_id == browser_id end)

        Enum.each(failed, fn {_id, call} ->
          Process.cancel_timer(call.timer)
          GenServer.reply(call.from, {:error, kind, "The selected browser disconnected"})
        end)

        %{state | connections: connections, calls: Map.new(calls)}
    end
  end
end
