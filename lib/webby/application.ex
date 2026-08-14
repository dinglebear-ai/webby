defmodule Webby.Application do
  # See https://elixir.hexdocs.pm/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application
  require Logger

  @impl true
  def start(_type, _args) do
    children = [
      WebbyWeb.Telemetry,
      Webby.Repo,
      {Ecto.Migrator,
       repos: Application.fetch_env!(:webby, :ecto_repos), skip: skip_migrations?()},
      Webby.SchemaMetadata,
      {Task.Supervisor, name: Webby.ProbeSupervisor},
      {DNSCluster, query: Application.get_env(:webby, :dns_cluster_query) || :ignore},
      {Phoenix.PubSub, name: Webby.PubSub},
      Webby.BrowserConnections,
      # Start a worker by calling: Webby.Worker.start_link(arg)
      # {Webby.Worker, arg},
      # Start to serve requests, typically the last entry
      WebbyWeb.Endpoint
    ]

    children =
      if Application.get_env(:webby, :runtime_discovery, true) do
        children ++ [{Webby.RuntimeDiscovery, []}, Webby.RuntimeStatusCache]
      else
        children ++ [Webby.RuntimeStatusCache]
      end

    # See https://elixir.hexdocs.pm/Supervisor.html
    # for other strategies and supported options
    opts = [strategy: :rest_for_one, name: Webby.Supervisor]
    Supervisor.start_link(children, opts)
  end

  # Tell Phoenix to update the endpoint configuration
  # whenever the application is updated.
  @impl true
  def config_change(changed, _new, removed) do
    WebbyWeb.Endpoint.config_change(changed, removed)
    :ok
  end

  @impl true
  def prep_stop(state) do
    if Application.get_env(:webby, :runtime_discovery, true) do
      case Webby.RuntimeDiscovery.cleanup() do
        :ok -> :ok
        error -> Logger.error("runtime discovery cleanup failed", reason: inspect(error))
      end
    end

    state
  end

  defp skip_migrations? do
    # By default, sqlite migrations are run when using a release
    System.get_env("RELEASE_NAME") == nil
  end
end
