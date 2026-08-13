defmodule WebbyWeb.StatusControllerTest do
  use WebbyWeb.ConnCase, async: false

  test "GET /health returns the public healthy status contract", %{conn: conn} do
    response = conn |> get(~p"/health") |> json_response(200)

    assert Map.keys(response) |> Enum.sort() == ~w(database runtime service status)
    assert response["service"] == "webby"
    assert response["database"]["journal_mode"] == "wal"
  end

  test "GET /health returns a redacted degraded status", %{conn: conn} do
    previous = Application.get_env(:webby, :runtime_status_module)
    Application.put_env(:webby, :runtime_status_module, Webby.TestDegradedRuntimeStatus)
    on_exit(fn -> Application.put_env(:webby, :runtime_status_module, previous) end)

    response = conn |> get(~p"/health") |> json_response(503)

    assert response["database"] == %{
             "status" => "error",
             "kind" => "database_unavailable"
           }

    refute inspect(response) =~ "script"
    refute inspect(response) =~ System.user_home()
  end
end
