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
    with {:ok, %{"sha" => sha}} <- get("#{@github}/repos/#{repo}/contents/#{path}", headers()),
         {:ok, commits} when is_list(commits) <- get(commits_url(repo, path, 1), headers()) do
      {:ok, %{"blob_sha" => sha, "last_commit" => commits |> List.first(%{}) |> Map.get("sha")}}
    else
      {:ok, _body} -> {:error, "unexpected response for #{repo}/#{path}"}
      {:error, reason} -> {:error, reason}
    end
  end

  @commit_page 30

  @doc """
  Commits touching `path` since `since_sha`, newest first.

  Bounded at #{@commit_page} commits. A pin left unreviewed for longer than
  that returns a truncated list rather than paging indefinitely; the report
  says so and links the full compare view.
  """
  @impl true
  def github_commits(repo, path, since_sha) do
    case get(commits_url(repo, path, @commit_page), headers()) do
      {:ok, commits} when is_list(commits) ->
        {:ok,
         commits
         |> Enum.take_while(&(not same_commit?(&1["sha"], since_sha)))
         |> Enum.map(&summarize/1)}

      {:ok, _body} ->
        {:error, "unexpected commit payload for #{repo}/#{path}"}

      {:error, reason} ->
        {:error, reason}
    end
  end

  # A pin may be recorded abbreviated while the API always answers in full, so
  # compare by prefix rather than treating a short pin as "never reached".
  defp same_commit?(sha, since) when is_binary(sha) and is_binary(since),
    do: String.starts_with?(sha, since) or String.starts_with?(since, sha)

  defp same_commit?(_sha, _since), do: false

  defp commits_url(repo, path, per_page),
    do: "#{@github}/repos/#{repo}/commits?path=#{URI.encode_www_form(path)}&per_page=#{per_page}"

  defp summarize(commit) do
    message = get_in(commit, ["commit", "message"]) || ""

    %{
      "sha" => commit["sha"],
      "subject" => message |> String.split("\n") |> List.first() |> to_string(),
      "date" => get_in(commit, ["commit", "author", "date"])
    }
  end

  @impl true
  def github_tags(repo) do
    case get("#{@github}/repos/#{repo}/tags?per_page=100", headers()) do
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

  defp headers do
    base = [{"accept", "application/vnd.github+json"}]

    case System.get_env("GITHUB_TOKEN") do
      token when is_binary(token) and token != "" -> [{"authorization", "Bearer #{token}"} | base]
      _ -> base
    end
  end
end
