defmodule Webby.PagesTest do
  use Webby.DataCase, async: false

  alias Webby.Browsers.Browser
  alias Webby.{Discovery, Pages}

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
end
