defmodule Webby.UpstreamContracts.ReqFetcher do
  @moduledoc """
  Live network access for `Webby.UpstreamContracts`.

  Split out behind a plain module boundary so the contract logic can be tested
  without reaching the network. Every function returns `{:ok, observed_fields}`
  or `{:error, reason}`; a transport failure is reported, never guessed around.
  """

  @behaviour Webby.UpstreamContracts.Fetcher

  @github "https://api.github.com"
  @npm "https://registry.npmjs.org"
  @receive_timeout 15_000

  @impl true
  def github_file(repo, path) do
    case get("#{@github}/repos/#{repo}/contents/#{path}", github_headers()) do
      {:ok, %{"sha" => sha}} -> {:ok, %{"blob_sha" => sha}}
      {:ok, _body} -> {:error, "no sha in response for #{repo}/#{path}"}
      {:error, reason} -> {:error, reason}
    end
  end

  @impl true
  def github_tags(repo) do
    case get("#{@github}/repos/#{repo}/tags?per_page=100", github_headers()) do
      {:ok, tags} when is_list(tags) ->
        names = Enum.flat_map(tags, fn tag -> List.wrap(tag["name"]) end)
        {:ok, %{"latest_tag" => List.first(names), "tags" => names}}

      {:ok, _body} ->
        {:error, "unexpected tag payload for #{repo}"}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @impl true
  def npm_package(package) do
    case get("#{@npm}/#{package}/latest", []) do
      {:ok, %{"version" => version}} -> {:ok, %{"version" => version}}
      {:ok, _body} -> {:error, "no version in response for #{package}"}
      {:error, reason} -> {:error, reason}
    end
  end

  defp get(url, headers) do
    case Req.get(url, headers: headers, receive_timeout: @receive_timeout, retry: :transient) do
      {:ok, %Req.Response{status: 200, body: body}} ->
        {:ok, body}

      {:ok, %Req.Response{status: status}} ->
        {:error, "HTTP #{status} from #{url}"}

      {:error, exception} ->
        {:error, Exception.message(exception)}
    end
  end

  defp github_headers do
    base = [{"accept", "application/vnd.github+json"}]

    case System.get_env("GITHUB_TOKEN") do
      token when is_binary(token) and token != "" -> [{"authorization", "Bearer #{token}"} | base]
      _ -> base
    end
  end
end
