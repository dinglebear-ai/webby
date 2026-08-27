defmodule Webby.DataRetention do
  @moduledoc "Retention and explicit erasure operations for browser-derived metadata."

  import Ecto.Query

  alias Webby.Browsers.{Browser, PairingRequest}
  alias Webby.Discovery.Discovery
  alias Webby.InvocationAudit
  alias Webby.Pages.DocumentSession
  alias Webby.Repo

  @max_batch_size 5_000

  def prune(cutoffs, batch_size \\ 500) when batch_size in 1..@max_batch_size do
    Repo.transaction(fn ->
      %{
        discoveries: prune_schema(Discovery, Map.fetch!(cutoffs, :discoveries), batch_size),
        sessions: prune_schema(DocumentSession, Map.fetch!(cutoffs, :sessions), batch_size),
        pairings: prune_schema(PairingRequest, Map.fetch!(cutoffs, :pairings), batch_size),
        invocations: prune_invocations(Map.fetch!(cutoffs, :invocations), batch_size)
      }
    end)
  end

  def erase_browser(browser_id, opts \\ []) do
    erase_browser_with_policy(browser_id, Keyword.get(opts, :audits, :anonymize))
  end

  defp erase_browser_with_policy(browser_id, audit_policy)
       when audit_policy in [:anonymize, :delete],
       do: Repo.transaction(fn -> fetch_and_erase_browser!(browser_id, audit_policy) end)

  defp erase_browser_with_policy(_browser_id, _audit_policy),
    do: {:error, :invalid_audit_policy}

  defp fetch_and_erase_browser!(browser_id, audit_policy) do
    browser = Repo.get(Browser, browser_id) || Repo.rollback(:not_found)
    erase_browser!(browser, audit_policy)
  end

  defp erase_browser!(browser, audit_policy) do
    deleted_audits =
      case audit_policy do
        :delete ->
          elem(Repo.delete_all(from a in InvocationAudit, where: a.browser_id == ^browser.id), 0)

        :anonymize ->
          0
      end

    {pairings, _} =
      Repo.delete_all(from p in PairingRequest, where: p.browser_id == ^browser.id)

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

    elem(Repo.delete_all(from row in schema, where: row.id in ^ids), 0)
  end

  defp prune_invocations(cutoff, batch_size) do
    {:ok, count} = Webby.Invocations.prune_before(cutoff, batch_size)
    count
  end
end
