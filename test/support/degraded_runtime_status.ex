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
       runtime: %{
         schema_version: 1,
         product_version: "0.1.0",
         base_url: "http://127.0.0.1:6477",
         capabilities: %{health: %{status: "available"}, mcp: %{status: "unavailable"}}
       }
     }}
  end
end
