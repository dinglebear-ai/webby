defmodule Webby.UpstreamContractsTest do
  use ExUnit.Case, async: true

  alias Webby.UpstreamContracts

  defmodule StubFetcher do
    @behaviour Webby.UpstreamContracts.Fetcher

    @impl true
    def github_file("webmachinelearning/webmcp", "index.bs"), do: {:ok, %{"blob_sha" => "moved"}}
    def github_file(_repo, _path), do: {:ok, %{"blob_sha" => "pinned"}}

    @impl true
    def github_tags(_repo), do: {:ok, %{"latest_tag" => "2026-07-28", "tags" => ["2026-07-28"]}}

    @impl true
    def npm_package(_package), do: {:ok, %{"version" => "0.1.3"}}
  end

  defmodule FailingFetcher do
    @behaviour Webby.UpstreamContracts.Fetcher

    @impl true
    def github_file(_repo, _path), do: {:error, "HTTP 503"}

    @impl true
    def github_tags(_repo), do: {:error, "HTTP 503"}

    @impl true
    def npm_package(_package), do: {:error, "HTTP 503"}
  end

  defp lock do
    %{
      "contracts" => %{
        "webmcp-spec" => %{
          "kind" => "github_file",
          "repo" => "webmachinelearning/webmcp",
          "path" => "index.bs",
          "blob_sha" => "pinned",
          "why" => "Normative WebMCP spec.",
          "webby_surfaces" => ["extension/src/probe.js"]
        },
        "webmcp-types" => %{
          "kind" => "npm_package",
          "package" => "webmcp-types",
          "version" => "0.1.3",
          "why" => "Published type definitions."
        },
        "mcp-spec" => %{
          "kind" => "github_tags",
          "repo" => "modelcontextprotocol/modelcontextprotocol",
          "latest_tag" => "2026-07-28",
          "why" => "MCP protocol revisions."
        }
      }
    }
  end

  describe "diff/2" do
    test "reports only the contract whose tracked field moved" do
      {observed, []} = UpstreamContracts.observe(lock(), StubFetcher)

      assert [entry] = UpstreamContracts.diff(lock(), observed)
      assert entry.id == "webmcp-spec"
      assert entry.key == "blob_sha"
      assert entry.locked == "pinned"
      assert entry.live == "moved"
    end

    test "is empty when every tracked field matches" do
      lock = put_in(lock(), ["contracts", "webmcp-spec", "blob_sha"], "moved")
      {observed, []} = UpstreamContracts.observe(lock, StubFetcher)

      assert UpstreamContracts.diff(lock, observed) == []
    end

    test "an unobserved contract is not reported as drift" do
      {observed, errors} = UpstreamContracts.observe(lock(), FailingFetcher)

      assert UpstreamContracts.diff(lock(), observed) == []
      assert length(errors) == 3
      assert Enum.all?(errors, fn {_id, reason} -> reason == "HTTP 503" end)
    end
  end

  describe "protocol_alignment/2" do
    test "is aligned when Webby's latest matches the newest published revision" do
      alignment =
        UpstreamContracts.protocol_alignment(
          ["2026-07-28", "2025-11-25"],
          ["2026-07-28", "2025-11-25"]
        )

      refute alignment.behind?
      assert alignment.unknown_versions == []
    end

    test "flags Webby as behind when upstream publishes a newer revision" do
      alignment =
        UpstreamContracts.protocol_alignment(
          ["2026-11-01", "2026-07-28"],
          ["2026-07-28"]
        )

      assert alignment.behind?
      assert alignment.upstream_latest == "2026-11-01"
      assert alignment.webby_latest == "2026-07-28"
    end

    test "ignores release candidates when deciding the newest revision" do
      alignment =
        UpstreamContracts.protocol_alignment(
          ["2026-11-01-RC", "2026-07-28"],
          ["2026-07-28"]
        )

      refute alignment.behind?
    end

    test "flags a supported version upstream never published" do
      alignment =
        UpstreamContracts.protocol_alignment(["2026-07-28"], ["2026-07-28", "1999-01-01"])

      assert alignment.unknown_versions == ["1999-01-01"]
    end
  end

  describe "render/3" do
    test "is empty when there is nothing to report" do
      aligned = UpstreamContracts.protocol_alignment(["2026-07-28"], ["2026-07-28"])

      assert UpstreamContracts.render([], aligned, []) == ""
    end

    test "names the drifted contract, both values, and the surfaces to re-check" do
      {observed, []} = UpstreamContracts.observe(lock(), StubFetcher)
      drift = UpstreamContracts.diff(lock(), observed)
      aligned = UpstreamContracts.protocol_alignment(["2026-07-28"], ["2026-07-28"])

      report = UpstreamContracts.render(drift, aligned, [])

      assert report =~ "webmcp-spec"
      assert report =~ "pinned"
      assert report =~ "moved"
      assert report =~ "extension/src/probe.js"
      assert report =~ "https://github.com/webmachinelearning/webmcp/commits/main/index.bs"
    end

    test "reports unreachable contracts separately from drift" do
      aligned = UpstreamContracts.protocol_alignment(["2026-07-28"], ["2026-07-28"])

      report = UpstreamContracts.render([], aligned, [{"webmcp-spec", "HTTP 503"}])

      assert report =~ "Could not be checked"
      assert report =~ "HTTP 503"
    end
  end

  describe "apply_observations/3" do
    test "writes observed values back and stamps the review date" do
      {observed, []} = UpstreamContracts.observe(lock(), StubFetcher)

      updated =
        lock() |> UpstreamContracts.apply_observations(observed, "2026-08-14") |> Jason.decode!()

      assert updated["updated_at"] == "2026-08-14"
      assert updated["contracts"]["webmcp-spec"]["blob_sha"] == "moved"
      assert updated["contracts"]["webmcp-spec"]["why"] == "Normative WebMCP spec."
    end
  end

  describe "the checked-in lock file" do
    test "parses and covers every contract kind the checker understands" do
      assert {:ok, lock} = UpstreamContracts.load_lock()

      contracts = lock["contracts"]
      assert map_size(contracts) > 0

      for {id, contract} <- contracts do
        assert contract["kind"] in ["github_file", "github_tags", "npm_package"],
               "#{id} has an unrecognized kind"

        assert is_binary(contract["why"]) and contract["why"] != "",
               "#{id} must record why it is tracked"
      end
    end

    test "pins the MCP revision Webby actually advertises" do
      assert {:ok, lock} = UpstreamContracts.load_lock()

      [webby_latest | _] = Webby.MCP.Protocol.supported_versions()
      assert lock["contracts"]["mcp-spec"]["latest_tag"] == webby_latest
    end
  end
end
