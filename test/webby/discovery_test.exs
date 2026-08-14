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

    changed_again = put_in(observation, ["tools", Access.at(0), "description"], "Changed again")
    assert {:ok, :ignored} = Discovery.observe(browser.id, changed_again)
    assert Discovery.list_discoveries() == []
  end

  test "rejects empty, malformed, and oversized catalogs", %{browser: browser} do
    base = %{"url" => "https://example.com", "title" => "Page"}
    assert {:error, :invalid_catalog} = Discovery.observe(browser.id, Map.put(base, "tools", []))

    huge = String.duplicate("x", 33_000)
    tools = [%{"name" => "large", "input_schema" => %{"description" => huge}}]

    assert {:error, :catalog_too_large} =
             Discovery.observe(browser.id, Map.put(base, "tools", tools))

    deeply_nested = Enum.reduce(1..17, %{"type" => "string"}, fn _, acc -> %{"next" => acc} end)
    nested_tools = [%{"name" => "nested", "input_schema" => deeply_nested}]

    assert {:error, :catalog_too_large} =
             Discovery.observe(browser.id, Map.put(base, "tools", nested_tools))

    too_many_nodes = %{"enum" => Enum.to_list(1..2_100)}
    node_tools = [%{"name" => "wide", "input_schema" => too_many_nodes}]

    assert {:error, :catalog_too_large} =
             Discovery.observe(browser.id, Map.put(base, "tools", node_tools))
  end

  describe "tool annotations" do
    defp observation_with(tools) do
      %{
        "url" => "https://example.com/tools",
        "title" => "Tools",
        "tools" => tools
      }
    end

    test "carries the safety hints through to the stored catalog", %{browser: browser} do
      tools = [
        %{
          "name" => "read_page",
          "description" => "Read",
          "input_schema" => %{},
          "annotations" => %{"read_only_hint" => true, "untrusted_content_hint" => true}
        }
      ]

      assert {:ok, discovery} = Discovery.observe(browser.id, observation_with(tools))

      assert [%{"annotations" => annotations}] = discovery.catalog_summary["tools"]

      assert annotations == %{
               "read_only_hint" => true,
               "untrusted_content_hint" => true
             }
    end

    test "accepts the specification's camelCase spelling", %{browser: browser} do
      tools = [
        %{
          "name" => "read_page",
          "description" => "Read",
          "input_schema" => %{},
          "annotations" => %{"untrustedContentHint" => true}
        }
      ]

      assert {:ok, discovery} = Discovery.observe(browser.id, observation_with(tools))
      assert [%{"annotations" => annotations}] = discovery.catalog_summary["tools"]
      assert annotations["untrusted_content_hint"] == true
      assert annotations["read_only_hint"] == false
    end

    test "defaults both hints to false when a page omits them", %{browser: browser} do
      tools = [%{"name" => "read_page", "description" => "Read", "input_schema" => %{}}]

      assert {:ok, discovery} = Discovery.observe(browser.id, observation_with(tools))

      assert [%{"annotations" => annotations}] = discovery.catalog_summary["tools"]

      assert annotations == %{
               "read_only_hint" => false,
               "untrusted_content_hint" => false
             }
    end

    test "records a non-boolean hint as false rather than truthy", %{browser: browser} do
      tools = [
        %{
          "name" => "read_page",
          "description" => "Read",
          "input_schema" => %{},
          "annotations" => %{"read_only_hint" => "yes", "untrusted_content_hint" => 1}
        }
      ]

      assert {:ok, discovery} = Discovery.observe(browser.id, observation_with(tools))

      assert [%{"annotations" => annotations}] = discovery.catalog_summary["tools"]

      assert annotations == %{
               "read_only_hint" => false,
               "untrusted_content_hint" => false
             }
    end

    test "refuses extra keys a page tries to smuggle into the catalog", %{browser: browser} do
      tools = [
        %{
          "name" => "read_page",
          "description" => "Read",
          "input_schema" => %{},
          "annotations" => %{"read_only_hint" => true, "evil" => "payload"}
        }
      ]

      assert {:ok, discovery} = Discovery.observe(browser.id, observation_with(tools))
      assert [%{"annotations" => annotations}] = discovery.catalog_summary["tools"]
      assert Map.keys(annotations) |> Enum.sort() == ["read_only_hint", "untrusted_content_hint"]
    end

    test "ignores an annotations value that is not a map", %{browser: browser} do
      tools = [
        %{
          "name" => "read_page",
          "description" => "Read",
          "input_schema" => %{},
          "annotations" => "read_only"
        }
      ]

      assert {:ok, discovery} = Discovery.observe(browser.id, observation_with(tools))
      assert [%{"annotations" => annotations}] = discovery.catalog_summary["tools"]
      assert annotations["read_only_hint"] == false
    end
  end
end
