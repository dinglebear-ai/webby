defmodule Webby.DurableConstraintsTest do
  use Webby.DataCase, async: false

  alias Ecto.Adapters.SQL
  alias Webby.Browsers.{Browser, PairingRequest}
  alias Webby.Discovery.Discovery
  alias Webby.Pages.{DocumentSession, PageRegistration}

  setup do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    browser =
      %Browser{}
      |> Browser.changeset(%{
        display_name: "Constraint browser",
        extension_id: "constraint-browser-extension",
        public_key: :crypto.strong_rand_bytes(32),
        scanning_mode: "granted_sites",
        paired_at: now
      })
      |> Repo.insert!()

    registration =
      %PageRegistration{}
      |> PageRegistration.changeset(%{
        slug: "constraint-page",
        display_name: "Constraint page",
        origin: "https://constraints.example",
        url_pattern: "/",
        auto_attach: true,
        enabled: true,
        exposure_mode: "broker"
      })
      |> Repo.insert!()

    pairing =
      %PairingRequest{browser_id: browser.id}
      |> PairingRequest.changeset(%{
        display_name: "Completed pairing",
        extension_id: "completed-pairing-extension",
        public_key: :crypto.strong_rand_bytes(32),
        scanning_mode: "granted_sites",
        status: "approved",
        expires_at: DateTime.add(now, 300, :second),
        resolved_at: now
      })
      |> Repo.insert!()

    discovery =
      %Discovery{}
      |> Discovery.changeset(%{
        browser_id: browser.id,
        origin: "https://unregistered.example",
        sanitized_path: "/",
        page_title: "Unregistered",
        tool_count: 1,
        catalog_fingerprint: String.duplicate("a", 64),
        catalog_summary: %{"tools" => [%{"name" => "find"}]},
        first_seen_at: now,
        last_seen_at: now,
        detection_count: 1,
        state: "discovered"
      })
      |> Repo.insert!()

    session =
      %DocumentSession{}
      |> DocumentSession.changeset(%{
        browser_id: browser.id,
        registration_id: registration.id,
        tab_id: 1,
        document_id: "constraint-document",
        current_origin: registration.origin,
        sanitized_path: "/",
        page_title: "Constraint page",
        catalog_revision: 1,
        catalog_fingerprint: String.duplicate("b", 64),
        catalog_summary: %{"tools" => [%{"name" => "find"}]},
        connected_at: now,
        last_seen_at: now,
        status: "active"
      })
      |> Repo.insert!()

    %{
      browser: browser,
      discovery: discovery,
      pairing: pairing,
      registration: registration,
      session: session
    }
  end

  test "direct SQL rejects invalid discovery enum and numeric state", %{discovery: discovery} do
    assert_raise Exqlite.Error, fn ->
      SQL.query!(Webby.Repo, "UPDATE discoveries SET state = 'invalid' WHERE id = ?", [
        discovery.id
      ])
    end

    assert_raise Exqlite.Error, fn ->
      SQL.query!(Webby.Repo, "UPDATE discoveries SET tool_count = 0 WHERE id = ?", [
        discovery.id
      ])
    end
  end

  test "direct SQL rejects invalid document-session enum and numeric state", %{session: session} do
    assert_raise Exqlite.Error, fn ->
      SQL.query!(Webby.Repo, "UPDATE document_sessions SET status = 'invalid' WHERE id = ?", [
        session.id
      ])
    end

    assert_raise Exqlite.Error, fn ->
      SQL.query!(Webby.Repo, "UPDATE document_sessions SET catalog_revision = 0 WHERE id = ?", [
        session.id
      ])
    end
  end

  test "direct SQL rejects invalid invocation enum and numeric state" do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    assert_raise Exqlite.Error, fn ->
      SQL.query!(
        Webby.Repo,
        "INSERT INTO invocation_audits (id, tool_name, catalog_revision, outcome, duration_ms, inserted_at) VALUES (?, ?, ?, ?, ?, ?)",
        [Ecto.UUID.generate(), "find", 0, "invalid", -1, now]
      )
    end
  end

  test "existing durable enum checks reject invalid browser, pairing, and exposure state",
       context do
    assert_raise Exqlite.Error, fn ->
      SQL.query!(Webby.Repo, "UPDATE browsers SET scanning_mode = 'invalid' WHERE id = ?", [
        context.browser.id
      ])
    end

    assert_raise Exqlite.Error, fn ->
      SQL.query!(
        Webby.Repo,
        "UPDATE browser_pairing_requests SET status = 'invalid' WHERE id = ?",
        [
          context.pairing.id
        ]
      )
    end

    assert_raise Exqlite.Error, fn ->
      SQL.query!(
        Webby.Repo,
        "UPDATE browser_pairing_requests SET scanning_mode = 'invalid' WHERE id = ?",
        [context.pairing.id]
      )
    end

    assert_raise Exqlite.Error, fn ->
      SQL.query!(
        Webby.Repo,
        "UPDATE page_registrations SET exposure_mode = 'invalid' WHERE id = ?",
        [
          context.registration.id
        ]
      )
    end
  end
end
