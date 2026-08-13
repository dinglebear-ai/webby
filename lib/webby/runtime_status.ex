defmodule Webby.RuntimeStatus do
  @moduledoc "Builds Webby's transport-neutral local health snapshot."

  alias Ecto.Adapters.SQL

  def snapshot(opts \\ []) do
    repo_probe = Keyword.get(opts, :repo_probe, &probe_repo/0)
    runtime_provider = Keyword.get(opts, :runtime_provider, &Webby.RuntimeDiscovery.snapshot/0)
    runtime = runtime_provider.()

    case safe_probe(repo_probe) do
      {:ok, journal_mode} ->
        {:ok,
         %{
           service: "webby",
           status: "ok",
           database: %{status: "ok", journal_mode: journal_mode},
           runtime: runtime
         }}

      {:error, reason} ->
        {:error,
         %{
           service: "webby",
           status: "error",
           database: %{status: "error", kind: normalize_error(reason)},
           runtime: runtime
         }}
    end
  end

  defp probe_repo do
    with {:ok, _result} <- SQL.query(Webby.Repo, "SELECT 1", []),
         {:ok, %{rows: [[journal_mode]]}} <- SQL.query(Webby.Repo, "PRAGMA journal_mode", []) do
      {:ok, String.downcase(journal_mode)}
    end
  end

  defp safe_probe(probe) do
    task = Task.Supervisor.async_nolink(Webby.ProbeSupervisor, probe)

    case Task.yield(task, 1_000) || Task.shutdown(task, :brutal_kill) do
      {:ok, result} -> result
      _timeout_or_exit -> {:error, :database_unavailable}
    end
  end

  defp normalize_error(:database_unavailable), do: "database_unavailable"
  defp normalize_error(_reason), do: "database_unavailable"
end
