defmodule WebbyWeb.StatusJSON do
  def show(%{snapshot: snapshot}) do
    %{
      service: snapshot.service,
      status: snapshot.status,
      database: public_database(snapshot.database),
      runtime: public_runtime(snapshot.runtime)
    }
  end

  defp public_database(%{status: "ok", journal_mode: mode}) do
    %{status: "ok", journal_mode: mode}
  end

  defp public_database(%{status: "error", kind: kind}) do
    %{status: "error", kind: kind}
  end

  defp public_runtime(runtime) do
    Map.take(runtime, [:instance_id, :base_url, :mcp_url, :pid])
  end
end
