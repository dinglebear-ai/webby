defmodule Webby.UpstreamContracts.Fetcher do
  @moduledoc "Observation surface for upstream contract sources."

  @type observed :: %{String.t() => term()}

  @callback github_file(repo :: String.t(), path :: String.t()) ::
              {:ok, observed()} | {:error, String.t()}
  @callback github_tags(repo :: String.t()) :: {:ok, observed()} | {:error, String.t()}
  @callback npm_package(package :: String.t()) :: {:ok, observed()} | {:error, String.t()}

  @doc """
  Commits touching `path` that land after `since_sha`, newest first.

  Used to answer what moved once drift is already known, so a report can name
  the upstream changes rather than only the hashes either side of them.
  """
  @callback github_commits(repo :: String.t(), path :: String.t(), since_sha :: String.t() | nil) ::
              {:ok, [map()]} | {:error, String.t()}

  @doc """
  Whether `symbol` appears in a file's current contents.

  Inverts the usual question. Most contracts ask "has this changed"; this one
  asks "has this arrived yet", so that an API Webby depends on but which
  upstream has not specified is watched for directly.
  """
  @callback github_file_symbol(repo :: String.t(), path :: String.t(), symbol :: String.t()) ::
              {:ok, observed()} | {:error, String.t()}

  @doc "Chrome's shipping status for a Chrome Status feature id."
  @callback chrome_status(feature_id :: integer()) :: {:ok, observed()} | {:error, String.t()}
end
