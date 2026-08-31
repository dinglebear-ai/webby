defmodule Webby.BrowserConnections do
  @moduledoc "Tracks authenticated browser channels and bounded tool calls."
  use GenServer
  require Logger

  alias Webby.MCP.Credentials

  @timeout 15_000
  @max_pending_calls 100
  @barrier_reconcile_retry_ms 1_000
  @tombstone_ttl_ms 60_000
  @audit_completion_attempts 2

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

  def finish_browser_erasure(browser_id, token, outcome),
    do: GenServer.call(__MODULE__, {:finish_browser_erasure, browser_id, token, outcome})

  @doc false
  def reconcile_owner_down(kind, id, token),
    do: GenServer.call(__MODULE__, {:reconcile_owner_down, kind, id, token})

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
      browser_erasures: %{}
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
    if browser_erased?(state, browser_id) do
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
      browser_erased?(state, browser_id) ->
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
        start_call(
          state,
          browser_id,
          payload,
          timeout,
          external_key,
          audit_id,
          credential_id,
          from
        )
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

  def handle_call({:begin_credential_revocation, credential_id}, from, state) do
    token = make_ref()
    {owner, _tag} = from

    barrier =
      Map.get(state.credential_barriers, credential_id, new_barrier(:revoking))

    barrier = %{barrier | owners: Map.put(barrier.owners, token, Process.monitor(owner))}
    barriers = Map.put(state.credential_barriers, credential_id, barrier)
    {:reply, {:ok, token}, %{state | credential_barriers: barriers}}
  end

  def handle_call({:reconcile_owner_down, :credential, id, token}, _from, state) do
    case finish_dead_credential_owner(state, id, token) do
      {:ok, next_state} -> {:reply, :ok, next_state}
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:reconcile_owner_down, :browser, id, token}, _from, state) do
    case finish_dead_erasure_owner(state, id, token) do
      {:ok, next_state} -> {:reply, :ok, next_state}
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:finish_credential_revocation, credential_id, token, :committed}, _from, state) do
    case finish_credential_owner(state, credential_id, token, :revoked) do
      {:ok, state} ->
        {:reply, :ok, commit_credential_revocation(state, credential_id)}

      {:error, reason} ->
        {:reply, {:error, reason}, state}
    end
  end

  def handle_call(
        {:finish_credential_revocation, credential_id, token, :aborted},
        _from,
        state
      ) do
    case finish_credential_owner(state, credential_id, token, :revoking) do
      {:ok, state} -> {:reply, :ok, state}
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:begin_browser_erasure, browser_id}, from, state) do
    token = make_ref()
    {owner, _tag} = from

    erasure =
      Map.get(state.browser_erasures, browser_id, new_barrier(:erasing))

    erasure = %{erasure | owners: Map.put(erasure.owners, token, Process.monitor(owner))}

    {:reply, {:ok, token}, put_in(state, [:browser_erasures, browser_id], erasure)}
  end

  def handle_call({:finish_browser_erasure, browser_id, token, :committed}, _from, state) do
    case finish_browser_erasure_owner(state, browser_id, token) do
      {:ok, erasure} ->
        case state.connections[browser_id] do
          %{pid: pid} -> send(pid, :browser_erased)
          nil -> :ok
        end

        state = put_in(state, [:browser_erasures, browser_id], %{erasure | status: :erased})
        {:reply, :ok, commit_browser_erasure(state, browser_id)}

      {:error, reason} ->
        {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:finish_browser_erasure, browser_id, token, :aborted}, _from, state) do
    case finish_browser_erasure_owner(state, browser_id, token) do
      {:ok, erasure} ->
        browser_erasures =
          if erasure.status == :erasing and map_size(erasure.owners) == 0,
            do: Map.delete(state.browser_erasures, browser_id),
            else: Map.put(state.browser_erasures, browser_id, erasure)

        {:reply, :ok, %{state | browser_erasures: browser_erasures}}

      {:error, reason} ->
        {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:browser_admissible, browser_id}, _from, state) do
    reply =
      if browser_erased?(state, browser_id),
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
        case release_barrier_owner(state, monitor) do
          {:ok, state} ->
            notify_barrier_down_processed(monitor)
            {:noreply, state}

          :not_found ->
            ids = calls_for_monitor(state, monitor)
            complete_caller_down_audits(state, ids)
            {:noreply, finish_calls(state, ids, :caller_down)}
        end
    end
  end

  def handle_info({:reconcile_barrier, kind, id, generation}, state),
    do: {:noreply, reconcile_barrier_if_current(state, kind, id, generation)}

  def handle_info({:expire_tombstone, :credential, credential_id, generation}, state) do
    barriers = expire_tombstone(state.credential_barriers, credential_id, :revoked, generation)
    {:noreply, %{state | credential_barriers: barriers}}
  end

  def handle_info({:expire_tombstone, :browser, browser_id, generation}, state) do
    erasures = expire_tombstone(state.browser_erasures, browser_id, :erased, generation)
    {:noreply, %{state | browser_erasures: erasures}}
  end

  defp start_call(
         state,
         browser_id,
         payload,
         timeout,
         external_key,
         audit_id,
         credential_id,
         from
       ) do
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
          credential_id: credential_id,
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

  defp finish_credential_owner(state, credential_id, token, requested_status) do
    with %{owners: owners} = barrier <- state.credential_barriers[credential_id],
         {:ok, monitor} <- Map.fetch(owners, token) do
      Process.demonitor(monitor, [:flush])
      status = if barrier.status == :revoked, do: :revoked, else: requested_status
      barrier = %{barrier | status: status, owners: Map.delete(owners, token)}

      if barrier.status == :revoked and map_size(barrier.owners) == 0,
        do: schedule_tombstone_expiry(:credential, credential_id, barrier.generation)

      barriers =
        if barrier.status == :revoking and map_size(barrier.owners) == 0,
          do: Map.delete(state.credential_barriers, credential_id),
          else: Map.put(state.credential_barriers, credential_id, barrier)

      {:ok, %{state | credential_barriers: barriers}}
    else
      _missing -> {:error, :not_revocation_owner}
    end
  end

  defp browser_erased?(state, browser_id) do
    match?(
      %{status: status} when status in [:erasing, :erased],
      state.browser_erasures[browser_id]
    )
  end

  defp finish_browser_erasure_owner(state, browser_id, token) do
    with %{owners: owners} = erasure <- state.browser_erasures[browser_id],
         {:ok, monitor} <- Map.fetch(owners, token) do
      Process.demonitor(monitor, [:flush])
      erasure = %{erasure | owners: Map.delete(owners, token)}

      if erasure.status == :erased and map_size(erasure.owners) == 0,
        do: schedule_tombstone_expiry(:browser, browser_id, erasure.generation)

      {:ok, erasure}
    else
      _missing -> {:error, :not_erasure_owner}
    end
  end

  defp release_barrier_owner(state, monitor) do
    case find_barrier_owner(state.credential_barriers, monitor) do
      {:ok, credential_id, token} ->
        finish_dead_credential_owner(state, credential_id, token)

      :not_found ->
        case find_barrier_owner(state.browser_erasures, monitor) do
          {:ok, browser_id, token} -> finish_dead_erasure_owner(state, browser_id, token)
          :not_found -> :not_found
        end
    end
  end

  defp find_barrier_owner(barriers, monitor) do
    Enum.find_value(barriers, :not_found, fn {id, %{owners: owners}} ->
      with {:ok, token} <- owner_for_monitor(owners, monitor), do: {:ok, id, token}
    end)
  end

  defp owner_for_monitor(owners, monitor) do
    case Enum.find(owners, fn {_token, owner_monitor} -> owner_monitor == monitor end) do
      {token, ^monitor} -> {:ok, token}
      nil -> :not_found
    end
  end

  defp finish_dead_credential_owner(state, credential_id, token) do
    with %{owners: owners} = barrier <- state.credential_barriers[credential_id],
         true <- Map.has_key?(owners, token) do
      barrier = %{barrier | owners: Map.delete(owners, token)}

      state =
        %{state | credential_barriers: Map.put(state.credential_barriers, credential_id, barrier)}

      state =
        if barrier.status == :revoking and map_size(barrier.owners) == 0,
          do: reconcile_barrier(state, :credential, credential_id),
          else: state

      {:ok, state}
    else
      _missing -> {:error, :not_revocation_owner}
    end
  end

  defp finish_dead_erasure_owner(state, browser_id, token) do
    with %{owners: owners} = erasure <- state.browser_erasures[browser_id],
         true <- Map.has_key?(owners, token) do
      erasure = %{erasure | owners: Map.delete(owners, token)}

      state = %{state | browser_erasures: Map.put(state.browser_erasures, browser_id, erasure)}

      state =
        if erasure.status == :erasing and map_size(erasure.owners) == 0,
          do: reconcile_barrier(state, :browser, browser_id),
          else: state

      {:ok, state}
    else
      _missing -> {:error, :not_erasure_owner}
    end
  end

  defp reconcile_barrier_if_current(state, kind, id, generation) do
    case barrier_for(state, kind, id) do
      %{generation: ^generation, status: status, owners: owners}
      when status in [:revoking, :erasing] and map_size(owners) == 0 ->
        reconcile_barrier(state, kind, id)

      _stale_or_owned ->
        state
    end
  end

  defp reconcile_barrier(state, :credential, credential_id) do
    case authoritative_credential_revoked?(credential_id) do
      true ->
        commit_credential_revocation(state, credential_id)

      false ->
        %{state | credential_barriers: Map.delete(state.credential_barriers, credential_id)}

      {:error, reason} ->
        retry_reconciliation(state, :credential, credential_id, reason)
    end
  end

  defp reconcile_barrier(state, :browser, browser_id) do
    case authoritative_browser_erased?(browser_id) do
      true -> commit_browser_erasure(state, browser_id)
      false -> %{state | browser_erasures: Map.delete(state.browser_erasures, browser_id)}
      {:error, reason} -> retry_reconciliation(state, :browser, browser_id, reason)
    end
  end

  defp authoritative_credential_revoked?(credential_id) do
    checker =
      Application.get_env(:webby, :credential_revocation_reconciler, fn id ->
        Credentials.revoked?(id)
      end)

    checker.(credential_id)
  rescue
    exception -> {:error, exception}
  catch
    kind, reason -> {:error, {kind, reason}}
  end

  defp authoritative_browser_erased?(browser_id) do
    checker =
      Application.get_env(:webby, :browser_erasure_reconciler, fn id ->
        Webby.DataRetention.erased?(id)
      end)

    checker.(browser_id)
  rescue
    exception -> {:error, exception}
  catch
    kind, reason -> {:error, {kind, reason}}
  end

  defp retry_reconciliation(state, kind, id, reason) do
    Logger.error("barrier reconciliation failed; retaining fail-closed denial",
      kind: kind,
      id: id,
      reason: inspect(reason)
    )

    %{generation: generation} = barrier_for(state, kind, id)

    Process.send_after(
      self(),
      {:reconcile_barrier, kind, id, generation},
      barrier_reconcile_retry_ms()
    )

    state
  end

  defp commit_credential_revocation(state, credential_id) do
    barrier = Map.get(state.credential_barriers, credential_id, new_barrier(:revoked))
    barrier = Map.put(barrier, :status, :revoked)

    state = %{
      state
      | credential_barriers: Map.put(state.credential_barriers, credential_id, barrier)
    }

    ids = matching_calls(state, &(&1.credential_id == credential_id))
    schedule_tombstone_expiry(:credential, credential_id, barrier.generation)
    finish_calls(state, ids, :credential_revoked)
  end

  defp commit_browser_erasure(state, browser_id) do
    erasure = Map.get(state.browser_erasures, browser_id, new_barrier(:erased))
    erasure = Map.put(erasure, :status, :erased)

    case state.connections[browser_id] do
      %{pid: pid} -> send(pid, :browser_erased)
      nil -> :ok
    end

    schedule_tombstone_expiry(:browser, browser_id, erasure.generation)

    state
    |> put_in([:browser_erasures, browser_id], erasure)
    |> drop_connection(browser_id, "browser_erased")
  end

  defp schedule_tombstone_expiry(kind, id, generation),
    do:
      Process.send_after(
        self(),
        {:expire_tombstone, kind, id, generation},
        tombstone_ttl_ms()
      )

  defp expire_tombstone(tombstones, id, expected_status, generation) do
    case tombstones[id] do
      %{status: ^expected_status, generation: ^generation, owners: owners}
      when map_size(owners) == 0 ->
        Map.delete(tombstones, id)

      %{status: ^expected_status, generation: ^generation} ->
        schedule_tombstone_expiry(tombstone_kind(expected_status), id, generation)
        tombstones

      _other ->
        tombstones
    end
  end

  defp new_barrier(status), do: %{status: status, owners: %{}, generation: make_ref()}
  defp barrier_for(state, :credential, id), do: state.credential_barriers[id]
  defp barrier_for(state, :browser, id), do: state.browser_erasures[id]
  defp tombstone_kind(:revoked), do: :credential
  defp tombstone_kind(:erased), do: :browser

  defp barrier_reconcile_retry_ms,
    do: Application.get_env(:webby, :barrier_reconcile_retry_ms, @barrier_reconcile_retry_ms)

  defp tombstone_ttl_ms,
    do: Application.get_env(:webby, :barrier_tombstone_ttl_ms, @tombstone_ttl_ms)

  defp calls_for_monitor(state, monitor),
    do: matching_calls(state, &(&1.caller_monitor == monitor))

  defp notify_barrier_down_processed(monitor) do
    case Application.get_env(:webby, :barrier_down_observer) do
      observer when is_function(observer, 1) -> observer.(monitor)
      nil -> :ok
    end
  end

  defp complete_caller_down_audits(state, ids) do
    Enum.each(ids, fn id -> complete_caller_down_audit(state.calls[id].audit_id) end)
  end

  defp complete_caller_down_audit(nil), do: :ok

  defp complete_caller_down_audit(audit_id) do
    starter =
      Application.get_env(:webby, :caller_down_audit_starter, fn operation ->
        Task.Supervisor.start_child(Webby.ProbeSupervisor, operation)
      end)

    completion =
      Application.get_env(
        :webby,
        :caller_down_audit_completion,
        &Webby.Invocations.complete_audit/4
      )

    operation = fn ->
      complete_audit_with_retry(completion, audit_id, @audit_completion_attempts)
    end

    case safely_start_audit(starter, operation) do
      {:ok, _pid} -> :ok
      {:error, reason} -> complete_caller_down_audit_inline(operation, audit_id, reason)
    end
  end

  defp safely_start_audit(starter, operation) do
    case starter.(operation) do
      {:ok, pid} when is_pid(pid) -> {:ok, pid}
      {:error, reason} -> {:error, reason}
      unexpected -> {:error, {:unexpected_start_result, unexpected}}
    end
  rescue
    exception -> {:error, {:raise, exception}}
  catch
    kind, reason -> {:error, {kind, reason}}
  end

  defp complete_audit_with_retry(completion, audit_id, attempts_left) do
    result =
      observe_audit_completion(
        fn -> completion.(audit_id, "failed", "caller_down", 0) end,
        audit_id
      )

    case {result, attempts_left} do
      {{:ok, _count}, _attempts} ->
        result

      {{:error, _reason}, attempts} when attempts > 1 ->
        complete_audit_with_retry(completion, audit_id, attempts - 1)

      _exhausted ->
        result
    end
  end

  defp observe_audit_completion(operation, audit_id) do
    case operation.() do
      {:ok, _count} = result ->
        result

      {:error, reason} = error ->
        Logger.error("caller-down audit completion failed",
          audit_id: audit_id,
          reason: inspect(reason)
        )

        error
    end
  rescue
    exception ->
      Logger.error("caller-down audit completion raised",
        audit_id: audit_id,
        reason: Exception.message(exception)
      )

      {:error, exception}
  catch
    kind, reason ->
      Logger.error("caller-down audit completion terminated",
        audit_id: audit_id,
        reason: inspect({kind, reason})
      )

      {:error, {kind, reason}}
  end

  defp complete_caller_down_audit_inline(operation, audit_id, launch_reason) do
    case operation.() do
      {:ok, _count} ->
        :ok

      {:error, reason} ->
        Logger.error("caller-down audit completion failed after task launch failure",
          audit_id: audit_id,
          launch_reason: inspect(launch_reason),
          reason: inspect(reason)
        )
    end
  rescue
    exception ->
      Logger.error("caller-down audit completion raised after task launch failure",
        audit_id: audit_id,
        launch_reason: inspect(launch_reason),
        reason: Exception.message(exception)
      )
  catch
    kind, reason ->
      Logger.error("caller-down audit completion terminated after task launch failure",
        audit_id: audit_id,
        launch_reason: inspect(launch_reason),
        reason: inspect({kind, reason})
      )
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
