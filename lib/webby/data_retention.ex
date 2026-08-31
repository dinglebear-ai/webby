defmodule Webby.DataRetention do
  @moduledoc "Retention and explicit erasure operations for browser-derived metadata."

  import Ecto.Query

  alias Webby.Browsers.{Browser, PairingRequest}
  alias Webby.Discovery.Discovery
  alias Webby.InvocationAudit
  alias Webby.Pages.DocumentSession
  alias Webby.Repo

  @max_batch_size 5_000

  @doc false
  def maintain(state) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    abandoned_after_seconds =
      max(
        Keyword.fetch!(state, :abandoned_after_seconds),
        div(Application.get_env(:webby, :invocation_timeout_ms, 15_000) + 999, 1_000) + 1
      )

    with {:ok, _} <-
           Webby.Invocations.reconcile_abandoned(
             DateTime.add(now, -abandoned_after_seconds, :second)
           ) do
      drain(
        %{
          discoveries: cutoff(now, state, :discovery_days),
          sessions: cutoff(now, state, :session_days),
          pairings: cutoff(now, state, :pairing_days),
          invocations: cutoff(now, state, :invocation_days)
        },
        Keyword.fetch!(state, :batch_size)
      )
    end
  end

  def prune(cutoffs, batch_size \\ 500) when batch_size in 1..@max_batch_size do
    with {:ok, diagnostics} <- prune_batch(cutoffs, batch_size) do
      {:ok, Map.new(diagnostics, fn {key, value} -> {key, value.deleted} end)}
    end
  end

  @doc "Drains every eligible retention row in bounded transactions."
  def drain(cutoffs, batch_size \\ 500) when batch_size in 1..@max_batch_size do
    drain(cutoffs, batch_size, 1, zero_counts())
  end

  defp drain(cutoffs, batch_size, batch, totals) do
    {:ok, diagnostics} = prune_batch(cutoffs, batch_size)
    counts = Map.new(diagnostics, fn {key, value} -> {key, value.deleted} end)
    examined = diagnostics |> Map.values() |> Enum.sum_by(& &1.examined)
    deleted = Enum.sum(Map.values(counts))

    totals = Map.merge(totals, counts, fn _key, total, count -> total + count end)

    if examined == 0 do
      batch_count = batch - 1

      :telemetry.execute(
        [:webby, :retention, :drain],
        %{batch_count: batch_count, rows_deleted: Enum.sum(Map.values(totals))},
        %{counts: totals, batch_size: batch_size}
      )

      {:ok, %{counts: totals, batch_count: batch_count}}
    else
      :telemetry.execute(
        [:webby, :retention, :batch],
        %{batch: batch, rows_examined: examined, rows_deleted: deleted},
        %{counts: counts, diagnostics: diagnostics, batch_size: batch_size}
      )

      drain(cutoffs, batch_size, batch + 1, totals)
    end
  end

  defp zero_counts,
    do: %{discoveries: 0, sessions: 0, pairings: 0, invocations: 0}

  defp prune_batch(cutoffs, batch_size) do
    Repo.transaction(fn ->
      %{
        discoveries: prune_schema(Discovery, Map.fetch!(cutoffs, :discoveries), batch_size),
        sessions: prune_sessions(Map.fetch!(cutoffs, :sessions), batch_size),
        pairings: prune_pairings(Map.fetch!(cutoffs, :pairings), batch_size),
        invocations: prune_invocations(Map.fetch!(cutoffs, :invocations), batch_size)
      }
    end)
  end

  def erase_browser(browser_id, opts \\ []) do
    audit_policy = Keyword.get(opts, :audits, :anonymize)
    after_tombstone = Keyword.get(opts, :after_tombstone, fn -> :ok end)

    if audit_policy in [:anonymize, :delete] do
      erase_with_tombstone(browser_id, audit_policy, after_tombstone)
    else
      {:error, :invalid_audit_policy}
    end
  end

  defp erase_with_tombstone(browser_id, audit_policy, after_tombstone) do
    {:ok, erasure_token} = Webby.BrowserConnections.begin_browser_erasure(browser_id)

    try do
      :ok = after_tombstone.()

      case erase_browser_with_policy(browser_id, audit_policy) do
        {:ok, _result} = result ->
          :ok =
            Webby.BrowserConnections.finish_browser_erasure(
              browser_id,
              erasure_token,
              :committed
            )

          result

        error ->
          :ok =
            Webby.BrowserConnections.finish_browser_erasure(browser_id, erasure_token, :aborted)

          error
      end
    rescue
      exception ->
        :ok =
          Webby.BrowserConnections.finish_browser_erasure(browser_id, erasure_token, :aborted)

        reraise exception, __STACKTRACE__
    catch
      kind, reason ->
        :ok =
          Webby.BrowserConnections.finish_browser_erasure(browser_id, erasure_token, :aborted)

        :erlang.raise(kind, reason, __STACKTRACE__)
    end
  end

  defp erase_browser_with_policy(browser_id, audit_policy)
       when audit_policy in [:anonymize, :delete],
       do: Repo.transaction(fn -> fetch_and_erase_browser!(browser_id, audit_policy) end)

  defp fetch_and_erase_browser!(browser_id, audit_policy) do
    browser = Repo.get(Browser, browser_id) || Repo.rollback(:not_found)
    erase_browser!(browser, audit_policy)
  end

  defp erase_browser!(browser, audit_policy) do
    Repo.update_all(
      from(a in InvocationAudit, where: a.browser_id == ^browser.id and a.outcome == "started"),
      set: [outcome: "failed", error_kind: "browser_erased", duration_ms: 0]
    )

    deleted_audits =
      case audit_policy do
        :delete ->
          elem(Repo.delete_all(from a in InvocationAudit, where: a.browser_id == ^browser.id), 0)

        :anonymize ->
          0
      end

    {pairings, _} =
      Repo.delete_all(
        from p in PairingRequest,
          where:
            p.browser_id == ^browser.id or
              (p.extension_id == ^browser.extension_id and p.public_key == ^browser.public_key)
      )

    Repo.delete!(browser)

    %{
      browser_id: browser.id,
      audits: audit_policy,
      deleted_audits: deleted_audits,
      deleted_pairings: pairings
    }
  end

  defp prune_schema(schema, cutoff, batch_size) do
    ids =
      Repo.all(
        from row in schema,
          where: row.updated_at < ^cutoff,
          order_by: [asc: row.updated_at],
          limit: ^batch_size,
          select: row.id
      )

    %{examined: length(ids), deleted: delete_ids(schema, ids)}
  end

  defp prune_sessions(cutoff, batch_size) do
    ids =
      Repo.all(
        from session in DocumentSession,
          where: session.updated_at < ^cutoff and session.status != "active",
          order_by: [asc: session.updated_at],
          limit: ^batch_size,
          select: session.id
      )

    %{examined: length(ids), deleted: delete_ids(DocumentSession, ids)}
  end

  defp prune_pairings(cutoff, batch_size) do
    ids =
      Repo.all(
        from pairing in PairingRequest,
          where: pairing.updated_at < ^cutoff and pairing.status != "pending",
          order_by: [asc: pairing.updated_at],
          limit: ^batch_size,
          select: pairing.id
      )

    %{examined: length(ids), deleted: delete_ids(PairingRequest, ids)}
  end

  defp prune_invocations(cutoff, batch_size) do
    {examined, deleted} = Webby.Invocations.prune_before_diagnostics(cutoff, batch_size)
    %{examined: examined, deleted: deleted}
  end

  defp delete_ids(_schema, []), do: 0

  defp delete_ids(schema, ids),
    do: elem(Repo.delete_all(from row in schema, where: row.id in ^ids), 0)

  defp cutoff(now, state, key),
    do: DateTime.add(now, -Keyword.fetch!(state, key), :day)
end
