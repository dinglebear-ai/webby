defmodule Webby.DataRetentionTest do
  use Webby.DataCase, async: false

  alias Webby.Browsers.{Browser, PairingRequest}
  alias Webby.DataRetention
  alias Webby.Discovery.Discovery
  alias Webby.InvocationAudit
  alias Webby.Pages.{DocumentSession, PageRegistration}
  alias Webby.Repo

  test "prunes each table by its own cutoff and batch while preserving recent and active audits" do
    now = DateTime.utc_now() |> DateTime.truncate(:second)
    old = DateTime.add(now, -30, :day)
    recent = DateTime.add(now, -1, :day)
    browser = insert_browser()
    registration = insert_registration(browser)

    discovery_ids = insert_discoveries(browser, [old, old, recent])
    session_ids = insert_sessions(browser, registration, [old, old, recent])
    pairing_ids = insert_pairings([old, old, recent])
    active_session_id = insert_session(browser, registration, old, 99, "active")
    pending_pairing_id = insert_pairing(old, 99, "pending")
    audit_ids = insert_audits(browser, registration, session_ids, [old, old, recent, old])

    cutoffs = %{
      discoveries: DateTime.add(now, -20, :day),
      sessions: DateTime.add(now, -15, :day),
      pairings: DateTime.add(now, -10, :day),
      invocations: DateTime.add(now, -5, :day)
    }

    assert {:ok, %{discoveries: 1, sessions: 1, pairings: 1, invocations: 1}} =
             DataRetention.prune(cutoffs, 1)

    assert Enum.count(Repo.all(Discovery), &(&1.id in discovery_ids)) == 2
    assert Enum.count(Repo.all(DocumentSession), &(&1.id in session_ids)) == 2
    assert Enum.count(Repo.all(PairingRequest), &(&1.id in pairing_ids)) == 2

    remaining_audits = Repo.all(InvocationAudit)
    assert Enum.count(remaining_audits, &(&1.id in audit_ids)) == 3
    assert Enum.any?(remaining_audits, &(&1.outcome == "started" and &1.inserted_at == old))
    assert Enum.any?(remaining_audits, &(&1.outcome == "succeeded" and &1.inserted_at == recent))
    assert Repo.get(DocumentSession, active_session_id)
    assert Repo.get(PairingRequest, pending_pairing_id)
  end

  defp insert_browser do
    {public_key, _private_key} = :crypto.generate_key(:eddsa, :ed25519)

    %Browser{}
    |> Browser.changeset(%{
      display_name: "Retention browser",
      extension_id: "retentionextensionidentifier",
      public_key: public_key,
      scanning_mode: "granted_sites",
      paired_at: DateTime.utc_now() |> DateTime.truncate(:second)
    })
    |> Repo.insert!()
  end

  defp insert_registration(browser) do
    %PageRegistration{}
    |> PageRegistration.changeset(%{
      slug: "retention-page",
      display_name: "Retention page",
      origin: "https://retention.example",
      url_pattern: "/page",
      preferred_browser_id: browser.id
    })
    |> Repo.insert!()
  end

  defp insert_discoveries(browser, timestamps) do
    timestamps
    |> Enum.with_index()
    |> Enum.map(fn {timestamp, index} ->
      discovery =
        %Discovery{}
        |> Discovery.changeset(%{
          browser_id: browser.id,
          origin: "https://discovery#{index}.example",
          sanitized_path: "/",
          page_title: "Discovery",
          tool_count: 1,
          catalog_fingerprint: String.duplicate(Integer.to_string(index + 1), 64),
          catalog_summary: %{},
          first_seen_at: timestamp,
          last_seen_at: timestamp
        })
        |> Repo.insert!()

      set_updated_at(Discovery, discovery.id, timestamp)
      discovery.id
    end)
  end

  defp insert_sessions(browser, registration, timestamps) do
    timestamps
    |> Enum.with_index()
    |> Enum.map(fn {timestamp, index} ->
      insert_session(browser, registration, timestamp, index, "closed")
    end)
  end

  defp insert_session(browser, registration, timestamp, index, status) do
    session =
      %DocumentSession{}
      |> DocumentSession.changeset(%{
        browser_id: browser.id,
        registration_id: registration.id,
        tab_id: index,
        document_id: "document-#{index}",
        current_origin: registration.origin,
        sanitized_path: registration.url_pattern,
        page_title: "Session",
        catalog_revision: 1,
        catalog_fingerprint: String.duplicate(Integer.to_string(rem(index, 6) + 4), 64),
        catalog_summary: %{},
        connected_at: timestamp,
        last_seen_at: timestamp,
        status: status
      })
      |> Repo.insert!()

    set_updated_at(DocumentSession, session.id, timestamp)
    session.id
  end

  defp insert_pairings(timestamps) do
    timestamps
    |> Enum.with_index()
    |> Enum.map(fn {timestamp, index} -> insert_pairing(timestamp, index, "rejected") end)
  end

  defp insert_pairing(timestamp, index, status) do
    pairing =
      %PairingRequest{}
      |> PairingRequest.changeset(%{
        display_name: "Pairing #{index}",
        extension_id: "retention-pairing-#{index}",
        public_key: :crypto.strong_rand_bytes(32),
        scanning_mode: "granted_sites",
        status: status,
        expires_at: timestamp,
        resolved_at: if(status == "pending", do: nil, else: timestamp)
      })
      |> Repo.insert!()

    set_updated_at(PairingRequest, pairing.id, timestamp)
    pairing.id
  end

  defp insert_audits(browser, registration, session_ids, timestamps) do
    timestamps
    |> Enum.with_index()
    |> Enum.map(fn {timestamp, index} ->
      outcome = if index == 3, do: "started", else: "succeeded"

      %InvocationAudit{inserted_at: timestamp}
      |> InvocationAudit.changeset(%{
        registration_id: registration.id,
        session_id: Enum.at(session_ids, min(index, 2)),
        browser_id: browser.id,
        tool_name: "retention-tool",
        catalog_revision: 1,
        outcome: outcome,
        duration_ms: 1
      })
      |> Repo.insert!()
      |> Map.fetch!(:id)
    end)
  end

  defp set_updated_at(schema, id, timestamp) do
    from(row in schema, where: row.id == ^id)
    |> Repo.update_all(set: [updated_at: timestamp])
  end
end
