defmodule Webby.DiscoveryTest do
  use Webby.DataCase, async: false

  alias Webby.Browsers.Browser
  alias Webby.Discovery

  setup do
    {public_key, _private_key} = :crypto.generate_key(:eddsa, :ed25519)

    {:ok, browser} =
      %Browser{}
      |> Browser.changeset(%{
        display_name: "Chrome",
        extension_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        public_key: public_key,
        scanning_mode: "granted_sites",
        paired_at: DateTime.utc_now() |> DateTime.truncate(:second)
      })
      |> Repo.insert()

    %{browser: browser}
  end

  test "strips credentials, query, and fragment from page identity" do
    assert {:ok, %{origin: "https://example.com:8443", sanitized_path: "/private"}} =
             Discovery.sanitize_url(
               "https://user:secret@example.com:8443/private?q=token#fragment"
             )

    assert {:error, :invalid_page_url} = Discovery.sanitize_url("chrome://settings")
    assert {:error, :invalid_page_url} = Discovery.sanitize_url("https://example.com/bad\\path")
  end

  test "deduplicates an unchanged catalog and retains fingerprinted changes", %{browser: browser} do
    observation = %{
      "url" => "https://example.com/search?q=secret",
      "title" => "Search",
      "tools" => [
        %{"name" => "search", "description" => "Search", "input_schema" => %{}}
      ]
    }

    assert {:ok, first} = Discovery.observe(browser.id, observation)

    assert {:ok, repeated} =
             Discovery.observe(browser.id, %{observation | "title" => "New title"})

    assert repeated.id == first.id
    assert repeated.detection_count == 2
    assert repeated.page_title == "New title"

    changed = put_in(observation, ["tools", Access.at(0), "description"], "Changed")
    assert {:ok, second} = Discovery.observe(browser.id, changed)
    refute second.catalog_fingerprint == first.catalog_fingerprint
    assert length(Discovery.list_discoveries()) == 2

    assert {:ok, %{origin: "https://example.com"}} = Discovery.ignore(first.id)
    assert Discovery.list_discoveries() == []
    assert Discovery.list_ignored_origins(browser.id) == ["https://example.com"]
  end

  test "rejects empty, malformed, and oversized catalogs", %{browser: browser} do
    base = %{"url" => "https://example.com", "title" => "Page"}
    assert {:error, :invalid_catalog} = Discovery.observe(browser.id, Map.put(base, "tools", []))

    huge = String.duplicate("x", 33_000)
    tools = [%{"name" => "large", "input_schema" => %{"description" => huge}}]

    assert {:error, :catalog_too_large} =
             Discovery.observe(browser.id, Map.put(base, "tools", tools))
  end
end
