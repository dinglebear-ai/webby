defmodule Webby.TestHealthyRuntimeStatus do
  @moduledoc false

  def snapshot do
    {:ok,
     %{
       service: "webby",
       status: "ok",
       database: %{status: "ok", journal_mode: "wal"},
       runtime: %{
         instance_id: "test-instance",
         schema_version: 1,
         product_version: "0.1.0",
         base_url: "http://127.0.0.1:6477",
         capabilities: %{health: %{status: "available"}, mcp: %{status: "unavailable"}},
         pid: 1234
       }
     }}
  end
end
