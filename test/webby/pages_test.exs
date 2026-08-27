defmodule Webby.PagesTest do
  use Webby.DataCase, async: false

  alias Webby.Browsers.Browser
  alias Webby.{Discovery, Pages}
  alias Webby.MCP.Broker

  setup do
    {public_key, _private_key} = :crypto.generate_key(:eddsa, :ed25519)

    {:ok, browser} =
      %Browser{}
      |> Browser.changeset(%{
        display_name: "Chrome",
        extension_id: "rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr",
        public_key: public_key,
        scanning_mode: "granted_sites",
        paired_at: DateTime.utc_now() |> DateTime.truncate(:second)
      })
      |> Repo.insert()

    observation = %{
      "url" => "https://example.com/search?secret=yes#private",
      "title" => "Search page",
      "tools" => [%{"name" => "find", "description" => "Find", "input_schema" => %{}}]
    }

    %{browser: browser, observation: observation}
  end

  test "promotes a sanitized discovery into an explicit registration", context do
    assert {:ok, discovery} = Discovery.observe(context.browser.id, context.observation)
    assert {:ok, registration} = Pages.register_discovery(discovery.id)

    assert registration.origin == "https://example.com"
    assert registration.url_pattern == "/search"
    assert registration.preferred_browser_id == context.browser.id
    assert registration.exposure_mode == "broker"
    assert Discovery.list_discoveries() == []
    assert {:ok, ^registration} = Pages.match("https://example.com", "/search")
    assert :none = Pages.match("https://example.com", "/other")
  end

  test "registered observations create and revise a live document session", context do
    assert {:ok, discovery} = Discovery.observe(context.browser.id, context.observation)
    assert {:ok, registration} = Pages.register_discovery(discovery.id)

    observed =
      Map.merge(context.observation, %{"tab_id" => 42, "document_id" => "document-one"})

    assert {:ok, first} = Discovery.observe(context.browser.id, observed)
    assert first.registration_id == registration.id
    assert first.catalog_revision == 1
    assert first.document_id == "document-one"

    changed =
      observed
      |> put_in(["tools", Access.at(0), "description"], "Changed")

    assert {:ok, revised_catalog} = Discovery.observe(context.browser.id, changed)
    assert revised_catalog.id == first.id
    assert revised_catalog.catalog_revision == 2

    navigated = Map.put(changed, "document_id", "document-two")

    assert {:ok, revised} = Discovery.observe(context.browser.id, navigated)
    refute revised.id == first.id
    assert revised.document_id == "document-two"
    assert revised.catalog_revision == 1

    replaced = Repo.get!(Webby.Pages.DocumentSession, first.id)
    assert replaced.status == "replaced"

    assert {:ok, 0} = Pages.close(context.browser.id, 42, "document-one")
    assert {:ok, 1} = Pages.close(context.browser.id, 42, "document-two")
    assert Pages.list_active_sessions() == []
  end

  test "registered pages require a browser document identity", context do
    assert {:ok, discovery} = Discovery.observe(context.browser.id, context.observation)
    assert {:ok, _registration} = Pages.register_discovery(discovery.id)

    assert {:error, :invalid_document_identity} =
             Discovery.observe(context.browser.id, context.observation)
  end

  test "resync closes sessions for documents no longer open", context do
    assert {:ok, discovery} = Discovery.observe(context.browser.id, context.observation)
    assert {:ok, _registration} = Pages.register_discovery(discovery.id)

    observed =
      Map.merge(context.observation, %{"tab_id" => 42, "document_id" => "document-one"})

    assert {:ok, _session} = Discovery.observe(context.browser.id, observed)
    assert [_active] = Pages.list_active_sessions()

    assert {:ok, []} = Discovery.resync(context.browser.id, [])
    assert Pages.list_active_sessions() == []
  end

  test "resync cancels calls bound to documents no longer open", context do
    assert {:ok, discovery} = Discovery.observe(context.browser.id, context.observation)
    assert {:ok, _registration} = Pages.register_discovery(discovery.id)

    observed =
      Map.merge(context.observation, %{"tab_id" => 42, "document_id" => "document-one"})

    assert {:ok, session} = Discovery.observe(context.browser.id, observed)
    assert :ok = Webby.BrowserConnections.register(context.browser.id, self())

    call =
      Task.async(fn ->
        Webby.BrowserConnections.call(context.browser.id, %{
          "tab_id" => session.tab_id,
          "document_id" => session.document_id,
          "catalog_revision" => session.catalog_revision
        })
      end)

    assert_receive {:tool_call, %{"call_id" => call_id}}
    assert {:ok, []} = Discovery.resync(context.browser.id, [])

    assert Task.await(call) ==
             {:error, "stale_document",
              "The browser document changed before the tool call completed"}

    assert_receive {:tool_cancel, %{"call_id" => ^call_id}}
  end

  test "resync closes sessions that no longer match an enabled registration", context do
    assert {:ok, discovery} = Discovery.observe(context.browser.id, context.observation)
    assert {:ok, registration} = Pages.register_discovery(discovery.id)

    observed =
      Map.merge(context.observation, %{"tab_id" => 42, "document_id" => "document-one"})

    assert {:ok, _session} = Discovery.observe(context.browser.id, observed)

    assert {:ok, _registration} =
             registration
             |> Ecto.Changeset.change(enabled: false)
             |> Repo.update()

    assert {:ok, [_discovery]} = Discovery.resync(context.browser.id, [observed])
    assert Pages.list_active_sessions() == []
    assert [%{state: "discovered"}] = Discovery.list_discoveries()
  end

  test "revoking a browser closes all of its live sessions", context do
    assert {:ok, discovery} = Discovery.observe(context.browser.id, context.observation)
    assert {:ok, _registration} = Pages.register_discovery(discovery.id)

    observed =
      Map.merge(context.observation, %{"tab_id" => 42, "document_id" => "document-one"})

    assert {:ok, _session} = Discovery.observe(context.browser.id, observed)
    assert [_active] = Pages.list_active_sessions()

    assert {:ok, _browser} = Webby.Browsers.revoke_browser(context.browser.id)
    assert Pages.list_active_sessions() == []
  end

  test "pausing scanning closes all live sessions", context do
    assert {:ok, discovery} = Discovery.observe(context.browser.id, context.observation)
    assert {:ok, _registration} = Pages.register_discovery(discovery.id)

    observed =
      Map.merge(context.observation, %{"tab_id" => 42, "document_id" => "document-one"})

    assert {:ok, _session} = Discovery.observe(context.browser.id, observed)

    assert {:ok, %{scanning_paused: true}} =
             Webby.Browsers.update_scanning(context.browser.id, "granted_sites", true)

    assert Pages.list_active_sessions() == []
  end

  test "page.call binds the exact document and records a metadata-only audit", context do
    assert {:ok, discovery} = Discovery.observe(context.browser.id, context.observation)
    assert {:ok, registration} = Pages.register_discovery(discovery.id)

    observed =
      Map.merge(context.observation, %{"tab_id" => 42, "document_id" => "document-one"})

    assert {:ok, session} = Discovery.observe(context.browser.id, observed)
    assert :ok = Webby.BrowserConnections.register(context.browser.id, self())

    task =
      Task.async(fn ->
        Broker.call(%{
          "action" => "page.call",
          "params" => %{
            "page" => registration.slug,
            "session" => session.id,
            "catalog_revision" => session.catalog_revision,
            "tool" => "find",
            "arguments" => %{"query" => "private input is not audited"}
          }
        })
      end)

    assert_receive {:tool_call,
                    %{
                      "call_id" => call_id,
                      "document_id" => "document-one",
                      "catalog_revision" => 1,
                      "tool_name" => "find"
                    }}

    Webby.BrowserConnections.complete(context.browser.id, %{
      "type" => "tool.result",
      "call_id" => call_id,
      "result" => %{"secret" => "not audited"}
    })

    assert Task.await(task) == {:ok, %{"secret" => "not audited"}}

    assert [audit] = Repo.all(Webby.InvocationAudit)
    assert audit.registration_id == registration.id
    assert audit.session_id == session.id
    assert audit.tool_name == "find"
    assert audit.outcome == "succeeded"
    refute Map.has_key?(Map.from_struct(audit), :arguments)
    refute Map.has_key?(Map.from_struct(audit), :result)
  end

  test "navigation and catalog revision changes cancel calls bound to stale documents", context do
    assert {:ok, discovery} = Discovery.observe(context.browser.id, context.observation)
    assert {:ok, _registration} = Pages.register_discovery(discovery.id)
    assert :ok = Webby.BrowserConnections.register(context.browser.id, self())

    observed = Map.merge(context.observation, %{"tab_id" => 42, "document_id" => "document-one"})
    assert {:ok, first} = Discovery.observe(context.browser.id, observed)

    revision_call =
      Task.async(fn ->
        Webby.BrowserConnections.call(context.browser.id, %{
          "tab_id" => 42,
          "document_id" => first.document_id,
          "catalog_revision" => first.catalog_revision
        })
      end)

    assert_receive {:tool_call, %{"call_id" => revision_call_id}}
    changed = put_in(observed, ["tools", Access.at(0), "description"], "Changed")
    assert {:ok, %{catalog_revision: 2}} = Discovery.observe(context.browser.id, changed)

    assert Task.await(revision_call) ==
             {:error, "stale_document",
              "The browser document changed before the tool call completed"}

    assert_receive {:tool_cancel, %{"call_id" => ^revision_call_id}}

    navigation_call =
      Task.async(fn ->
        Webby.BrowserConnections.call(context.browser.id, %{
          "tab_id" => 42,
          "document_id" => "document-one",
          "catalog_revision" => 2
        })
      end)

    assert_receive {:tool_call, %{"call_id" => navigation_call_id}}

    assert {:ok, %{document_id: "document-two"}} =
             Discovery.observe(
               context.browser.id,
               Map.put(changed, "document_id", "document-two")
             )

    assert Task.await(navigation_call) ==
             {:error, "stale_document",
              "The browser document changed before the tool call completed"}

    assert_receive {:tool_cancel, %{"call_id" => ^navigation_call_id}}
  end

  test "closing a document cancels its pending calls", context do
    assert :ok = Webby.BrowserConnections.register(context.browser.id, self())

    task =
      Task.async(fn ->
        Webby.BrowserConnections.call(context.browser.id, %{
          "tab_id" => 7,
          "document_id" => "closing",
          "catalog_revision" => 1
        })
      end)

    assert_receive {:tool_call, %{"call_id" => call_id}}
    assert {:ok, 0} = Pages.close(context.browser.id, 7, "closing")

    assert Task.await(task) ==
             {:error, "stale_document",
              "The browser document changed before the tool call completed"}

    assert_receive {:tool_cancel, %{"call_id" => ^call_id}}
  end

  test "explicit erasure removes one browser's metadata and anonymizes retained audits",
       context do
    assert {:ok, discovery} = Discovery.observe(context.browser.id, context.observation)
    assert {:ok, registration} = Pages.register_discovery(discovery.id)

    observed =
      Map.merge(context.observation, %{"tab_id" => 42, "document_id" => "document-one"})

    assert {:ok, session} = Discovery.observe(context.browser.id, observed)

    audit =
      %Webby.InvocationAudit{}
      |> Webby.InvocationAudit.changeset(%{
        registration_id: registration.id,
        session_id: session.id,
        browser_id: context.browser.id,
        tool_name: "find",
        catalog_revision: 1,
        outcome: "succeeded",
        duration_ms: 4
      })
      |> Repo.insert!()

    assert {:ok, %{audits: :anonymize}} = Webby.DataRetention.erase_browser(context.browser.id)
    assert Repo.get(Webby.Browsers.Browser, context.browser.id) == nil
    assert Repo.get(Webby.Pages.DocumentSession, session.id) == nil
    assert Repo.get!(Webby.InvocationAudit, audit.id).browser_id == nil
    assert Repo.get!(Webby.InvocationAudit, audit.id).session_id == nil
    assert Repo.get!(Webby.Pages.PageRegistration, registration.id).preferred_browser_id == nil
  end

  test "reconciles abandoned invocation audits without rewriting completed rows", context do
    assert {:ok, discovery} = Discovery.observe(context.browser.id, context.observation)
    assert {:ok, registration} = Pages.register_discovery(discovery.id)

    observed =
      Map.merge(context.observation, %{"tab_id" => 42, "document_id" => "document-one"})

    assert {:ok, session} = Discovery.observe(context.browser.id, observed)

    started =
      %Webby.InvocationAudit{}
      |> Webby.InvocationAudit.changeset(%{
        registration_id: registration.id,
        session_id: session.id,
        browser_id: context.browser.id,
        tool_name: "find",
        catalog_revision: 1,
        outcome: "started",
        duration_ms: 0
      })
      |> Repo.insert!()

    cutoff = DateTime.add(started.inserted_at, 1, :second)
    assert {:ok, 1} = Webby.Invocations.reconcile_abandoned(cutoff)
    assert %{outcome: "abandoned", error_kind: "interrupted"} = Repo.reload!(started)
    assert {:ok, 0} = Webby.Invocations.reconcile_abandoned(cutoff)
  end
end
