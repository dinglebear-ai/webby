defmodule WebbyWeb.DashboardLiveTest do
  use WebbyWeb.ConnCase, async: false

  import Phoenix.LiveViewTest

  test "renders the local foundation status", %{conn: conn} do
    {:ok, view, html} = live(conn, ~p"/")

    assert html =~ "Webby"
    assert html =~ "Local service"
    assert html =~ "SQLite"
    assert html =~ "127.0.0.1:6477"
    assert html =~ "MCP setup coming in a later delivery slice"
    assert has_element?(view, "[data-status=ok]")
  end

  test "does not render page-controlled markup", %{conn: conn} do
    previous = Application.get_env(:webby, :runtime_status_module)
    Application.put_env(:webby, :runtime_status_module, Webby.TestDegradedRuntimeStatus)
    on_exit(fn -> Application.put_env(:webby, :runtime_status_module, previous) end)

    {:ok, view, _html} = live(conn, ~p"/")

    refute has_element?(view, "script")
  end
end
