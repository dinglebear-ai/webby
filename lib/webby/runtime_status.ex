defmodule Webby.RuntimeStatus do
  @moduledoc "Builds Webby's transport-neutral local health snapshot."

  alias Ecto.Adapters.SQL
  require Logger

  def snapshot, do: Webby.RuntimeStatusCache.snapshot()

  def snapshot(opts) do
    repo_probe = Keyword.get(opts, :repo_probe, &probe_repo/0)
    runtime_provider = Keyword.get(opts, :runtime_provider, &runtime_snapshot/0)

    case safe_probe(fn -> {runtime_provider.(), repo_probe.()} end) do
      {runtime, {:ok, journal_mode}} ->
        {:ok,
         %{
           service: "webby",
           status: "ok",
           database: %{status: "ok", journal_mode: journal_mode},
           runtime: runtime
         }}

      {runtime, {:error, reason}} ->
        {:error,
         %{
           service: "webby",
           status: "error",
           database: %{status: "error", kind: normalize_error(reason)},
           runtime: runtime
         }}

      {:error, reason} ->
        {:error,
         %{
           service: "webby",
           status: "error",
           database: %{status: "error", kind: normalize_error(reason)},
           runtime: unavailable_runtime()
         }}
    end
  end

  defp probe_repo do
    with {:ok, _result} <- SQL.query(Webby.Repo, "SELECT 1", []),
         {:ok, %{rows: [[journal_mode]]}} <- SQL.query(Webby.Repo, "PRAGMA journal_mode", []) do
      {:ok, String.downcase(journal_mode)}
    end
  end

  defp runtime_snapshot do
    case Process.whereis(Webby.RuntimeDiscovery) do
      nil -> unavailable_runtime()
      _pid -> Webby.RuntimeDiscovery.snapshot()
    end
  end

  defp safe_probe(probe) do
    timeout = Application.get_env(:webby, :database_probe_timeout) || 1_000
    task = Task.Supervisor.async_nolink(Webby.ProbeSupervisor, probe)

    case Task.yield(task, timeout) || Task.shutdown(task, :brutal_kill) do
      {:ok, result} ->
        result

      nil ->
        Logger.warning("database health probe timed out", timeout_ms: timeout)
        {:error, :database_unavailable}

      {:exit, reason} ->
        Logger.error("database health probe exited", reason: inspect(reason))
        {:error, :database_unavailable}
    end
  end

  defp normalize_error(:database_unavailable), do: "database_unavailable"
  defp normalize_error(_reason), do: "database_unavailable"

  defp unavailable_runtime do
    %{
      schema_version: 1,
      product_version: Application.spec(:webby, :vsn) |> to_string(),
      base_url: nil,
      capabilities: %{
        health: %{status: "unavailable", kind: "runtime_starting", retryable: true},
        mcp: %{status: "unavailable", kind: "runtime_starting", retryable: true}
      }
    }
  end
end
