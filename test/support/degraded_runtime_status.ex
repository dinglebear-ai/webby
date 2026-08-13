defmodule Webby.TestDegradedRuntimeStatus do
  @moduledoc false

  def snapshot do
    {:error,
     %{
       service: "webby",
       status: "error",
       database: %{
         status: "error",
         kind: "database_unavailable",
         message: "<script>alert(1)</script>"
       },
       runtime: %{mcp_url: "http://127.0.0.1:6477/mcp"}
     }}
  end
end
