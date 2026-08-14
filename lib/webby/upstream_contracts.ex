defmodule Webby.UpstreamContracts do
  @moduledoc """
  Tracks the external specifications Webby implements against.

  Section 21 of the design spec requires that the authoritative external
  contracts be "pinned and recorded". This module is that pin: the lock file
  at `priv/contracts/upstream.lock.json` records the observed state of each
  upstream document, and `diff/2` reports where the live upstream has moved
  away from it.

  Drift is informational, not a defect. Upstream moving is expected; the point
  is to notice it deliberately rather than discover it when a browser ships a
  breaking change.
  """

  alias Webby.MCP.Protocol

  @default_lock_path "priv/contracts/upstream.lock.json"

  @tracked_keys %{
    "github_file" => ["blob_sha"],
    "github_tags" => ["latest_tag"],
    "npm_package" => ["version"]
  }

  @doc "Path to the checked-in lock file."
  def lock_path, do: Application.get_env(:webby, :upstream_lock_path, @default_lock_path)

  @doc "Reads and decodes the lock file."
  def load_lock(path \\ lock_path()) do
    with {:ok, body} <- File.read(path),
         {:ok, lock} <- Jason.decode(body) do
      {:ok, lock}
    else
      {:error, :enoent} -> {:error, "lock file not found at #{path}"}
      {:error, %Jason.DecodeError{} = error} -> {:error, Exception.message(error)}
      {:error, reason} -> {:error, inspect(reason)}
    end
  end

  @doc """
  Observes the live state of every contract in `lock`.

  Returns `{observations, errors}` where observations is a map of contract id
  to the observed fields, and errors is a list of `{id, reason}` for contracts
  that could not be reached.
  """
  def observe(lock, fetcher \\ Webby.UpstreamContracts.ReqFetcher) do
    lock
    |> contracts()
    |> Enum.reduce({%{}, []}, fn {id, contract}, {observed, errors} ->
      case observe_one(contract, fetcher) do
        {:ok, fields} -> {Map.put(observed, id, fields), errors}
        {:error, reason} -> {observed, [{id, reason} | errors]}
      end
    end)
    |> then(fn {observed, errors} -> {observed, Enum.reverse(errors)} end)
  end

  defp observe_one(%{"kind" => "github_file"} = contract, fetcher) do
    fetcher.github_file(contract["repo"], contract["path"])
  end

  defp observe_one(%{"kind" => "github_tags"} = contract, fetcher) do
    fetcher.github_tags(contract["repo"])
  end

  defp observe_one(%{"kind" => "npm_package"} = contract, fetcher) do
    fetcher.npm_package(contract["package"])
  end

  defp observe_one(%{"kind" => kind}, _fetcher), do: {:error, "unknown contract kind #{kind}"}

  @doc """
  Compares locked state against observations.

  Returns a list of drift maps, each naming the contract, the field that moved,
  and both values. An empty list means every tracked contract still matches.
  """
  def diff(lock, observed) do
    lock
    |> contracts()
    |> Enum.flat_map(fn {id, contract} ->
      diff_contract(id, contract, Map.get(observed, id))
    end)
  end

  defp diff_contract(_id, _contract, nil), do: []

  defp diff_contract(id, contract, fields) do
    @tracked_keys
    |> Map.get(contract["kind"], [])
    |> Enum.flat_map(&drift_entry(id, contract, fields, &1))
  end

  defp drift_entry(id, contract, fields, key) do
    locked = contract[key]
    live = fields[key]

    if is_nil(live) or locked == live do
      []
    else
      [%{id: id, contract: contract, key: key, locked: locked, live: live}]
    end
  end

  @doc """
  Checks that Webby's advertised MCP protocol versions still line up with the
  upstream specification's published revisions.

  Unlike `diff/2` this is a genuine conformance question: advertising a `latest`
  that upstream has superseded, or a version upstream never published, is a bug
  in Webby rather than mere drift.
  """
  def protocol_alignment(upstream_tags, supported \\ Protocol.supported_versions()) do
    published = upstream_tags |> Enum.reject(&String.ends_with?(&1, "-RC")) |> Enum.sort(:desc)
    [webby_latest | _] = supported

    unknown = Enum.reject(supported, &(&1 in published))
    upstream_latest = List.first(published)

    %{
      webby_latest: webby_latest,
      upstream_latest: upstream_latest,
      behind?: not is_nil(upstream_latest) and webby_latest != upstream_latest,
      unknown_versions: unknown
    }
  end

  @doc "Applies observations back onto the lock, returning encoded JSON to write."
  def apply_observations(lock, observed, today) do
    contracts =
      lock
      |> contracts()
      |> Map.new(fn {id, contract} ->
        {id, Map.merge(contract, Map.get(observed, id, %{}))}
      end)

    lock
    |> Map.put("contracts", contracts)
    |> Map.put("updated_at", today)
    |> Jason.encode!(pretty: true)
    |> Kernel.<>("\n")
  end

  @doc "Renders drift and alignment findings as a Markdown report."
  def render(drift, alignment, errors) do
    [
      render_alignment(alignment),
      render_drift(drift),
      render_errors(errors)
    ]
    |> Enum.reject(&(&1 == ""))
    |> Enum.join("\n")
  end

  defp render_alignment(%{behind?: false, unknown_versions: []}), do: ""

  defp render_alignment(alignment) do
    behind =
      if alignment.behind? do
        """
        - Webby advertises MCP `#{alignment.webby_latest}` as latest, but upstream has \
        published `#{alignment.upstream_latest}`. Review the changelog and decide whether \
        to adopt it in `Webby.MCP.Protocol`.
        """
      else
        ""
      end

    unknown =
      case alignment.unknown_versions do
        [] ->
          ""

        versions ->
          "- Webby claims support for #{Enum.map_join(versions, ", ", &"`#{&1}`")}, " <>
            "which upstream has not published as a release.\n"
      end

    "## MCP protocol alignment\n\n" <> behind <> unknown
  end

  defp render_drift([]), do: ""

  defp render_drift(drift) do
    rows =
      Enum.map_join(drift, "\n", fn entry ->
        """
        ### `#{entry.id}`

        #{entry.contract["why"]}

        - Pinned `#{entry.key}`: `#{entry.locked}`
        - Live `#{entry.key}`: `#{entry.live}`
        - Source: #{source_url(entry.contract)}
        - Webby surfaces to re-check: #{surfaces(entry.contract)}
        """
      end)

    "## Upstream contract drift\n\n" <> rows
  end

  defp render_errors([]), do: ""

  defp render_errors(errors) do
    rows = Enum.map_join(errors, "\n", fn {id, reason} -> "- `#{id}`: #{reason}" end)
    "## Could not be checked\n\n" <> rows <> "\n"
  end

  defp source_url(%{"kind" => "github_file"} = contract),
    do: "https://github.com/#{contract["repo"]}/commits/main/#{contract["path"]}"

  defp source_url(%{"kind" => "github_tags"} = contract),
    do: "https://github.com/#{contract["repo"]}/tags"

  defp source_url(%{"kind" => "npm_package"} = contract),
    do: "https://www.npmjs.com/package/#{contract["package"]}"

  defp source_url(_contract), do: "(unknown)"

  defp surfaces(contract) do
    case contract["webby_surfaces"] do
      [_ | _] = paths -> Enum.map_join(paths, ", ", &"`#{&1}`")
      _ -> "(none recorded)"
    end
  end

  defp contracts(lock), do: Map.get(lock, "contracts", %{})
end
