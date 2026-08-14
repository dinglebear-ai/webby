defmodule Webby.UpstreamContracts.Fetcher do
  @moduledoc "Observation surface for upstream contract sources."

  @type observed :: %{String.t() => term()}

  @callback github_file(repo :: String.t(), path :: String.t()) ::
              {:ok, observed()} | {:error, String.t()}
  @callback github_tags(repo :: String.t()) :: {:ok, observed()} | {:error, String.t()}
  @callback npm_package(package :: String.t()) :: {:ok, observed()} | {:error, String.t()}
end
