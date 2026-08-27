defmodule Webby.BrowserConnections do
  @moduledoc "Tracks authenticated browser channels and bounded tool calls."
  use GenServer
  require Logger

  @timeout 15_000
  @max_pending_calls 100

  def start_link(_opts), do: GenServer.start_link(__MODULE__, %{}, name: __MODULE__)

  def register(browser_id, pid \\ self()),
    do: GenServer.call(__MODULE__, {:register, browser_id, pid})

  def unregister(browser_id, pid \\ self()),
    do: GenServer.call(__MODULE__, {:unregister, browser_id, pid})

  def call(browser_id, payload, timeout \\ @timeout, external_key \\ nil),
    do:
      GenServer.call(
        __MODULE__,
        {:call, browser_id, payload, timeout, external_key},
        timeout + 1_000
      )

  def cancel(external_key), do: GenServer.call(__MODULE__, {:cancel, external_key})

  def cancel_document(browser_id, tab_id, document_id),
    do: GenServer.call(__MODULE__, {:cancel_document, browser_id, tab_id, document_id})

  def cancel_stale_document(browser_id, tab_id, document_id, catalog_revision),
    do:
      GenServer.call(
        __MODULE__,
        {:cancel_stale_document, browser_id, tab_id, document_id, catalog_revision}
      )

  def complete(browser_id, payload), do: complete(browser_id, self(), payload)

  def complete(browser_id, channel_pid, payload),
    do: GenServer.cast(__MODULE__, {:complete, browser_id, channel_pid, payload})

  @impl true
  def init(_state) do
    state = %{connections: %{}, calls: %{}, external_keys: %{}}

    if Application.get_env(:webby, Webby.Repo, [])[:pool] == Ecto.Adapters.SQL.Sandbox,
      do: {:ok, state},
      else: {:ok, state, {:continue, :close_stale_sessions}}
  end

  @impl true
  def handle_continue(:close_stale_sessions, state) do
    {:ok, _count} = Webby.Pages.close_all_active_sessions()
    {:noreply, state}
  end

  @impl true
  def handle_call({:register, browser_id, pid}, _from, state) do
    state = drop_connection(state, browser_id, "browser_replaced")
    connection = %{pid: pid, monitor: Process.monitor(pid), generation: make_ref()}
    {:reply, :ok, put_in(state, [:connections, browser_id], connection)}
  end

  def handle_call({:unregister, browser_id, pid}, _from, state) do
    case state.connections[browser_id] do
      %{pid: ^pid} -> {:reply, :ok, drop_connection(state, browser_id, "browser_offline")}
      _not_current -> {:reply, :stale, state}
    end
  end

  def handle_call({:call, browser_id, payload, timeout, external_key}, from, state) do
    cond do
      map_size(state.calls) >= @max_pending_calls ->
        {:reply, {:error, "server_busy", "Too many page tool calls are already pending"}, state}

      external_key != nil and Map.has_key?(state.external_keys, external_key) ->
        {:reply,
         {:error, "duplicate_request",
          "A tool call with this request identity is already pending"}, state}

      true ->
        start_call(state, browser_id, payload, timeout, external_key, from)
    end
  end

  def handle_call({:cancel, external_key}, _from, state) do
    case state.external_keys[external_key] do
      nil -> {:reply, :not_found, state}
      call_id -> {:reply, :ok, finish_call(state, call_id, :cancelled, true)}
    end
  end

  def handle_call({:cancel_document, browser_id, tab_id, document_id}, _from, state) do
    ids =
      matching_calls(state, fn call ->
        call.browser_id == browser_id and call.payload["tab_id"] == tab_id and
          call.payload["document_id"] == document_id
      end)

    {:reply, length(ids), finish_calls(state, ids, :stale_document)}
  end

  def handle_call(
        {:cancel_stale_document, browser_id, tab_id, document_id, catalog_revision},
        _from,
        state
      ) do
    ids =
      matching_calls(state, fn call ->
        call.browser_id == browser_id and call.payload["tab_id"] == tab_id and
          (call.payload["document_id"] != document_id or
             (call.payload["document_id"] == document_id and
                call.payload["catalog_revision"] != catalog_revision))
      end)

    {:reply, length(ids), finish_calls(state, ids, :stale_document)}
  end

  @impl true
  def handle_cast({:complete, browser_id, channel_pid, %{"call_id" => call_id} = payload}, state) do
    case state.calls[call_id] do
      %{browser_id: ^browser_id, channel_pid: ^channel_pid} ->
        {:noreply, finish_call(state, call_id, {:completion, payload}, false)}

      _unknown ->
        Logger.warning("ignored unmatched browser tool result",
          event: "browser.tool_result.unmatched",
          browser_id: browser_id,
          call_id: call_id
        )

        {:noreply, state}
    end
  end

  def handle_cast({:complete, _browser_id, _channel_pid, _payload}, state), do: {:noreply, state}

  @impl true
  def handle_info({:call_timeout, call_id}, state),
    do: {:noreply, finish_call(state, call_id, :timeout, true)}

  def handle_info({:DOWN, monitor, :process, _pid, _reason}, state) do
    case Enum.find(state.connections, fn {_id, connection} -> connection.monitor == monitor end) do
      {browser_id, _connection} ->
        {:noreply, drop_connection(state, browser_id, "browser_offline")}

      nil ->
        {:noreply,
         finish_calls(state, matching_calls(state, &(&1.caller_monitor == monitor)), :caller_down)}
    end
  end

  defp start_call(state, browser_id, payload, timeout, external_key, from) do
    case state.connections[browser_id] do
      %{pid: pid, generation: generation} ->
        call_id = Ecto.UUID.generate()
        timer = Process.send_after(self(), {:call_timeout, call_id}, timeout)
        {caller_pid, _tag} = from
        send(pid, {:tool_call, Map.put(payload, "call_id", call_id)})

        call = %{
          from: from,
          caller_monitor: Process.monitor(caller_pid),
          browser_id: browser_id,
          channel_pid: pid,
          generation: generation,
          timer: timer,
          payload: payload,
          external_key: external_key
        }

        state = put_in(state, [:calls, call_id], call)

        state =
          if external_key, do: put_in(state, [:external_keys, external_key], call_id), else: state

        {:noreply, state}

      nil ->
        {:reply, {:error, "browser_offline", "The selected browser is not connected"}, state}
    end
  end

  defp finish_calls(state, ids, reason) do
    Enum.reduce(
      ids,
      state,
      &finish_call(&2, &1, reason, reason != {:connection_lost, "browser_offline"})
    )
  end

  defp finish_call(state, call_id, reason, send_cancel?) do
    case Map.pop(state.calls, call_id) do
      {nil, _calls} ->
        state

      {call, calls} ->
        Process.cancel_timer(call.timer)
        Process.demonitor(call.caller_monitor, [:flush])

        if send_cancel?,
          do: send(call.channel_pid, {:tool_cancel, Map.put(call.payload, "call_id", call_id)})

        maybe_reply(call.from, reason)

        keys =
          if call.external_key,
            do: Map.delete(state.external_keys, call.external_key),
            else: state.external_keys

        %{state | calls: calls, external_keys: keys}
    end
  end

  defp maybe_reply(_from, :caller_down), do: :ok
  defp maybe_reply(from, {:completion, payload}), do: GenServer.reply(from, completion(payload))

  defp maybe_reply(from, :cancelled),
    do: GenServer.reply(from, {:error, "cancelled", "The MCP client cancelled the tool call"})

  defp maybe_reply(from, :timeout),
    do: GenServer.reply(from, {:error, "tool_timeout", "The page tool exceeded its time limit"})

  defp maybe_reply(from, :stale_document),
    do:
      GenServer.reply(
        from,
        {:error, "stale_document", "The browser document changed before the tool call completed"}
      )

  defp maybe_reply(from, {:connection_lost, kind}),
    do: GenServer.reply(from, {:error, kind, "The selected browser disconnected"})

  defp completion(%{"type" => "tool.result", "result" => result}), do: {:ok, result}

  defp completion(%{"type" => "tool.error", "error" => error}),
    do: {:error, error["kind"] || "tool_failed", error["message"] || "The page tool failed"}

  defp matching_calls(state, predicate),
    do: for({id, call} <- state.calls, predicate.(call), do: id)

  defp drop_connection(state, browser_id, kind) do
    case Map.pop(state.connections, browser_id) do
      {nil, _connections} ->
        state

      {%{monitor: monitor}, connections} ->
        Process.demonitor(monitor, [:flush])
        ids = matching_calls(state, &(&1.browser_id == browser_id))
        finish_calls(%{state | connections: connections}, ids, {:connection_lost, kind})
    end
  end
end
