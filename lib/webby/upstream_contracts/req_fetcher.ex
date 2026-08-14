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
  def github_file_symbol(repo, path, symbol) do
    case get("#{@github}/repos/#{repo}/contents/#{path}", headers("application/vnd.github.raw")) do
      {:ok, body} when is_binary(body) -> {:ok, %{"present" => String.contains?(body, symbol)}}
      {:ok, _body} -> {:error, "unexpected contents payload for #{repo}/#{path}"}
      {:error, reason} -> {:error, reason}
    end
  end

  @impl true
  def chrome_status(feature_id) do
    # The API serves `application/json` whose body begins with the anti-hijacking
    # guard `)]}'`, so Req's automatic decoding fails on the first byte. Take the
    # raw body and strip the guard before decoding.
    case get("https://chromestatus.com/api/v0/features/#{feature_id}", [], decode_body: false) do
      {:ok, body} when is_binary(body) ->
        case body |> String.replace_prefix(")]}'", "") |> Jason.decode() do
          {:ok, decoded} ->
            {:ok, %{"chrome_status" => get_in(decoded, ["browsers", "chrome", "status", "text"])}}

          {:error, _reason} ->
            {:error, "unexpected chromestatus payload for #{feature_id}"}
        end

      {:ok, _body} ->
        {:error, "unexpected chromestatus payload for #{feature_id}"}

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

  defp get(url, headers, opts \\ []) do
    options =
      [headers: headers, receive_timeout: @receive_timeout, retry: :transient] ++ opts

    case Req.get(url, options) do
      {:ok, %Req.Response{status: 200, body: body}} ->
        {:ok, body}

      {:ok, %Req.Response{status: status}} ->
        {:error, "HTTP #{status} from #{url}"}

      {:error, exception} ->
        {:error, Exception.message(exception)}
    end
  end

  # `application/vnd.github.raw` asks GitHub for the file body rather than the
  # JSON metadata envelope. Accept is a parameter rather than something a caller
  # splices in afterwards: an earlier version rebuilt the list positionally and
  # dropped the authorization header along with the accept it meant to replace,
  # which only showed up as a 403 once a token was actually present.
  defp headers(accept \\ "application/vnd.github+json") do
    base = [{"accept", accept}]

    case System.get_env("GITHUB_TOKEN") do
      token when is_binary(token) and token != "" -> [{"authorization", "Bearer #{token}"} | base]
      _ -> base
    end
  end
end
