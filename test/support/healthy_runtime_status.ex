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
         base_url: "http://127.0.0.1:6477",
         mcp_url: "http://127.0.0.1:6477/mcp",
         pid: 1234
       }
     }}
  end
end
