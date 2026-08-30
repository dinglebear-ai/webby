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

  def call(
        browser_id,
        payload,
        timeout \\ @timeout,
        external_key \\ nil,
        audit_id \\ nil,
        credential_id \\ nil
      ),
      do:
        GenServer.call(
          __MODULE__,
          {:call, browser_id, payload, timeout, external_key, audit_id, credential_id},
          timeout + 1_000
        )

  def cancel(external_key), do: GenServer.call(__MODULE__, {:cancel, external_key})

  def cancel_credential(credential_id),
    do: GenServer.call(__MODULE__, {:cancel_credential, credential_id})

  def begin_credential_revocation(credential_id),
    do: GenServer.call(__MODULE__, {:begin_credential_revocation, credential_id})

  def finish_credential_revocation(credential_id, token, outcome),
    do: GenServer.call(__MODULE__, {:finish_credential_revocation, credential_id, token, outcome})

  def begin_browser_erasure(browser_id),
    do: GenServer.call(__MODULE__, {:begin_browser_erasure, browser_id})

  def finish_browser_erasure(browser_id, outcome),
    do: GenServer.call(__MODULE__, {:finish_browser_erasure, browser_id, outcome})

  def browser_admissible?(browser_id),
    do: GenServer.call(__MODULE__, {:browser_admissible, browser_id})

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
    state = %{
      connections: %{},
      calls: %{},
      external_keys: %{},
      credential_barriers: %{},
      erased_browsers: MapSet.new()
    }

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
    if MapSet.member?(state.erased_browsers, browser_id) do
      {:reply, {:error, :browser_erased}, state}
    else
      state = drop_connection(state, browser_id, "browser_replaced")
      connection = %{pid: pid, monitor: Process.monitor(pid), generation: make_ref()}
      {:reply, :ok, put_in(state, [:connections, browser_id], connection)}
    end
  end

  def handle_call({:unregister, browser_id, pid}, _from, state) do
    case state.connections[browser_id] do
      %{pid: ^pid} -> {:reply, :ok, drop_connection(state, browser_id, "browser_offline")}
      _not_current -> {:reply, :stale, state}
    end
  end

  def handle_call(
        {:call, browser_id, payload, timeout, external_key, audit_id, credential_id},
        from,
        state
      ) do
    cond do
      MapSet.member?(state.erased_browsers, browser_id) ->
        {:reply, {:error, "browser_erased", "The selected browser was erased"}, state}

      map_size(state.calls) >= @max_pending_calls ->
        {:reply, {:error, "server_busy", "Too many page tool calls are already pending"}, state}

      external_key != nil and Map.has_key?(state.external_keys, external_key) ->
        {:reply,
         {:error, "duplicate_request",
          "A tool call with this request identity is already pending"}, state}

      credential_id != nil and Map.has_key?(state.credential_barriers, credential_id) ->
        {:reply, revoked_error(), state}

      true ->
        start_call(state, browser_id, payload, timeout, external_key, audit_id, from)
    end
  end

  def handle_call({:cancel, external_key}, _from, state) do
    case state.external_keys[external_key] do
      nil -> {:reply, :not_found, state}
      call_id -> {:reply, :ok, finish_call(state, call_id, :cancelled, true)}
    end
  end

  def handle_call({:cancel_credential, credential_id}, _from, state) do
    ids =
      matching_calls(state, fn call ->
        match?({^credential_id, _request_id}, call.external_key)
      end)

    {:reply, length(ids), finish_calls(state, ids, :credential_revoked)}
  end

  def handle_call({:begin_credential_revocation, credential_id}, _from, state) do
    token = make_ref()

    barrier =
      Map.get(state.credential_barriers, credential_id, %{status: :revoking, owners: MapSet.new()})

    barrier = %{barrier | owners: MapSet.put(barrier.owners, token)}
    barriers = Map.put(state.credential_barriers, credential_id, barrier)
    {:reply, {:ok, token}, %{state | credential_barriers: barriers}}
  end

  def handle_call({:finish_credential_revocation, credential_id, token, :committed}, _from, state) do
    ids = matching_calls(state, &match?({^credential_id, _request_id}, &1.external_key))
    barrier = barrier_without_owner(state, credential_id, token, :revoked)
    state = put_in(state, [:credential_barriers, credential_id], barrier)

    {:reply, :ok, finish_calls(state, ids, :credential_revoked)}
  end

  def handle_call(
        {:finish_credential_revocation, credential_id, token, :aborted},
        _from,
        state
      ) do
    barrier = barrier_without_owner(state, credential_id, token, :revoking)

    barriers =
      if barrier.status == :revoking and MapSet.size(barrier.owners) == 0,
        do: Map.delete(state.credential_barriers, credential_id),
        else: Map.put(state.credential_barriers, credential_id, barrier)

    {:reply, :ok, %{state | credential_barriers: barriers}}
  end

  def handle_call({:begin_browser_erasure, browser_id}, _from, state) do
    {:reply, :ok, %{state | erased_browsers: MapSet.put(state.erased_browsers, browser_id)}}
  end

  def handle_call({:finish_browser_erasure, browser_id, :committed}, _from, state) do
    case state.connections[browser_id] do
      %{pid: pid} -> send(pid, :browser_erased)
      nil -> :ok
    end

    {:reply, :ok, drop_connection(state, browser_id, "browser_erased")}
  end

  def handle_call({:finish_browser_erasure, browser_id, :aborted}, _from, state) do
    {:reply, :ok, %{state | erased_browsers: MapSet.delete(state.erased_browsers, browser_id)}}
  end

  def handle_call({:browser_admissible, browser_id}, _from, state) do
    reply =
      if MapSet.member?(state.erased_browsers, browser_id),
        do: {:error, :browser_erased},
        else: :ok

    {:reply, reply, state}
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
        ids = calls_for_monitor(state, monitor)
        complete_caller_down_audits(state, ids)
        {:noreply, finish_calls(state, ids, :caller_down)}
    end
  end

  defp start_call(state, browser_id, payload, timeout, external_key, audit_id, from) do
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
          external_key: external_key,
          audit_id: audit_id
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

  defp maybe_reply(from, :credential_revoked),
    do: GenServer.reply(from, {:error, "revoked", "The MCP credential was revoked"})

  defp maybe_reply(from, {:connection_lost, kind}),
    do: GenServer.reply(from, {:error, kind, "The selected browser disconnected"})

  defp revoked_error, do: {:error, "revoked", "The MCP credential was revoked"}

  defp completion(%{"type" => "tool.result", "result" => result}), do: {:ok, result}

  defp completion(%{"type" => "tool.error", "error" => error}),
    do: {:error, error["kind"] || "tool_failed", error["message"] || "The page tool failed"}

  defp matching_calls(state, predicate),
    do: for({id, call} <- state.calls, predicate.(call), do: id)

  defp barrier_without_owner(state, credential_id, token, requested_status) do
    barrier = Map.fetch!(state.credential_barriers, credential_id)
    status = if barrier.status == :revoked, do: :revoked, else: requested_status
    %{barrier | status: status, owners: MapSet.delete(barrier.owners, token)}
  end

  defp calls_for_monitor(state, monitor),
    do: matching_calls(state, &(&1.caller_monitor == monitor))

  defp complete_caller_down_audits(state, ids) do
    Enum.each(ids, fn id -> complete_caller_down_audit(state.calls[id].audit_id) end)
  end

  defp complete_caller_down_audit(nil), do: :ok

  defp complete_caller_down_audit(audit_id) do
    Task.Supervisor.start_child(Webby.ProbeSupervisor, fn ->
      Webby.Invocations.complete_audit(audit_id, "failed", "caller_down", 0)
    end)
  end

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
