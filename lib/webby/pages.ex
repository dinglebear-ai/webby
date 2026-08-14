defmodule Webby.Pages do
  @moduledoc "Explicit page registrations and live browser document bindings."

  import Ecto.Query
  alias Ecto.Multi
  alias Webby.Discovery.Discovery
  alias Webby.Pages.{DocumentSession, PageRegistration}
  alias Webby.Repo
  require Logger

  def list_registrations,
    do: Repo.all(from r in PageRegistration, order_by: [asc: r.display_name])

  def list_active_sessions do
    Repo.all(
      from s in DocumentSession,
        where: s.status == "active",
        preload: [:registration],
        order_by: [desc: s.last_seen_at]
    )
  end

  def register_discovery(id) do
    case Repo.get(Discovery, id) do
      %Discovery{state: "discovered"} = discovery ->
        case promote(discovery) do
          {:ok, registration} = result ->
            Logger.info("page registration created",
              event: "page.registration.created",
              registration_id: registration.id,
              browser_id: discovery.browser_id
            )

            result

          error ->
            error
        end

      nil ->
        {:error, :not_found}

      %Discovery{} ->
        {:error, :invalid_state}
    end
  end

  def match(origin, path) do
    Repo.all(
      from r in PageRegistration,
        where: r.enabled and r.auto_attach and r.origin == ^origin
    )
    |> Enum.filter(&path_matches?(&1.url_pattern, path))
    |> case do
      [registration] -> {:ok, registration}
      [] -> :none
      _many -> {:error, :ambiguous_registration}
    end
  end

  def attach(browser_id, registration, attrs) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    Repo.transaction(fn ->
      {replaced_count, _} = replace_other_documents(browser_id, attrs, now)
      existing = find_session(browser_id, attrs)
      session = upsert_session(existing, browser_id, registration, attrs, now)

      Logger.info("document session attached",
        event: "page.session.attached",
        browser_id: browser_id,
        registration_id: registration.id,
        session_id: session.id,
        catalog_revision: session.catalog_revision,
        replaced_count: replaced_count
      )

      session
    end)
  end

  def close(browser_id, tab_id, document_id) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    {count, _} =
      Repo.update_all(
        from(s in DocumentSession,
          where:
            s.browser_id == ^browser_id and s.tab_id == ^tab_id and
              s.document_id == ^document_id and s.status == "active"
        ),
        set: [status: "closed", last_seen_at: now, updated_at: now]
      )

    log_closed(browser_id, count, "page.session.closed")
    {:ok, count}
  end

  def reconcile(browser_id, observed_records) do
    current =
      observed_records
      |> Enum.flat_map(fn
        %DocumentSession{} = session -> [{session.tab_id, session.document_id}]
        _not_a_session -> []
      end)
      |> MapSet.new()

    stale_ids =
      Repo.all(
        from s in DocumentSession,
          where: s.browser_id == ^browser_id and s.status == "active",
          select: {s.id, s.tab_id, s.document_id}
      )
      |> Enum.reject(fn {_id, tab_id, document_id} ->
        MapSet.member?(current, {tab_id, document_id})
      end)
      |> Enum.map(&elem(&1, 0))

    case close_sessions(stale_ids) do
      {:ok, count} = result ->
        log_closed(browser_id, count, "page.session.reconciled")
        result
    end
  end

  def close_browser_sessions(browser_id, event \\ "page.session.browser_unavailable") do
    ids =
      Repo.all(
        from s in DocumentSession,
          where: s.browser_id == ^browser_id and s.status == "active",
          select: s.id
      )

    case close_sessions(ids) do
      {:ok, count} = result ->
        log_closed(browser_id, count, event)
        result
    end
  end

  defp path_matches?(pattern, path) do
    if String.ends_with?(pattern, "*") do
      String.starts_with?(path, String.trim_trailing(pattern, "*"))
    else
      pattern == path
    end
  end

  defp close_sessions([]), do: {:ok, 0}

  defp close_sessions(ids) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    {count, _} =
      Repo.update_all(
        from(s in DocumentSession, where: s.id in ^ids and s.status == "active"),
        set: [status: "closed", last_seen_at: now, updated_at: now]
      )

    {:ok, count}
  end

  defp promote(discovery) do
    Multi.new()
    |> Multi.insert(
      :registration,
      PageRegistration.changeset(%PageRegistration{}, %{
        slug: unique_slug(discovery.page_title),
        display_name: discovery.page_title,
        origin: discovery.origin,
        url_pattern: discovery.sanitized_path,
        preferred_browser_id: discovery.browser_id,
        auto_attach: true,
        enabled: true,
        exposure_mode: "broker"
      })
    )
    |> Multi.update_all(
      :discoveries,
      from(d in Discovery,
        where:
          d.origin == ^discovery.origin and d.sanitized_path == ^discovery.sanitized_path and
            d.state == "discovered"
      ),
      set: [state: "registered"]
    )
    |> Repo.transaction()
    |> case do
      {:ok, %{registration: registration}} -> {:ok, registration}
      {:error, _step, reason, _changes} -> {:error, reason}
    end
  end

  defp replace_other_documents(browser_id, attrs, now) do
    Repo.update_all(
      from(s in DocumentSession,
        where:
          s.browser_id == ^browser_id and s.tab_id == ^attrs.tab_id and
            s.document_id != ^attrs.document_id and s.status == "active"
      ),
      set: [status: "replaced", last_seen_at: now, updated_at: now]
    )
  end

  defp find_session(browser_id, attrs) do
    Repo.get_by(DocumentSession,
      browser_id: browser_id,
      tab_id: attrs.tab_id,
      document_id: attrs.document_id
    )
  end

  defp upsert_session(existing, browser_id, registration, attrs, now) do
    values =
      Map.merge(attrs, %{
        browser_id: browser_id,
        registration_id: registration.id,
        catalog_revision: catalog_revision(existing, attrs.catalog_fingerprint),
        connected_at: connected_at(existing, now),
        last_seen_at: now,
        status: "active"
      })

    case (existing || %DocumentSession{})
         |> DocumentSession.changeset(values)
         |> Repo.insert_or_update() do
      {:ok, session} -> session
      {:error, reason} -> Repo.rollback(reason)
    end
  end

  defp catalog_revision(nil, _fingerprint), do: 1

  defp catalog_revision(existing, fingerprint) do
    if existing.catalog_fingerprint == fingerprint,
      do: existing.catalog_revision,
      else: existing.catalog_revision + 1
  end

  defp connected_at(nil, now), do: now
  defp connected_at(existing, _now), do: existing.connected_at

  defp log_closed(_browser_id, 0, _event), do: :ok

  defp log_closed(browser_id, count, event) do
    Logger.info("document sessions closed",
      event: event,
      browser_id: browser_id,
      session_count: count
    )
  end

  defp unique_slug(title) do
    base =
      title
      |> String.downcase()
      |> String.replace(~r/[^a-z0-9]+/u, "-")
      |> String.trim("-")
      |> String.slice(0, 64)

    base = if base == "", do: "page", else: base

    if Repo.exists?(from r in PageRegistration, where: r.slug == ^base),
      do: base <> "-" <> String.slice(Ecto.UUID.generate(), 0, 8),
      else: base
  end
end
