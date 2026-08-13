defmodule WebbyWeb.DashboardLiveTest do
  use WebbyWeb.ConnCase, async: false

  import Phoenix.LiveViewTest

  test "renders status and browser pairing controls", %{conn: conn} do
    {:ok, view, html} = live(conn, ~p"/")

    assert html =~ "Webby"
    assert html =~ "Local service"
    assert html =~ "SQLite"
    assert html =~ "127.0.0.1:6477"
    assert html =~ "Browser pairing is active"
    assert html =~ "Pairing requests"
    assert html =~ "Paired browsers"
    assert has_element?(view, "[data-status=ok]")
  end

  test "locally approves and revokes a pending browser", %{conn: conn} do
    {public_key, _private_key} = :crypto.generate_key(:eddsa, :ed25519)

    {:ok, pairing} =
      Webby.Browsers.request_pairing(%{
        "display_name" => "Test Chrome",
        "extension_id" => "abcdefghijklmnopabcdefghijklmnop",
        "public_key" => Base.url_encode64(public_key, padding: false),
        "scanning_mode" => "granted_sites"
      })

    {:ok, view, _html} = live(conn, ~p"/")
    assert has_element?(view, "#pairing-#{pairing.id}", "Test Chrome")

    view |> element("#pairing-#{pairing.id} button", "Approve") |> render_click()
    [browser] = Webby.Browsers.list_browsers()
    assert has_element?(view, "#browser-#{browser.id}", "Test Chrome")

    view |> element("#browser-#{browser.id} button", "Revoke") |> render_click()
    assert render(view) =~ "Revoked"
  end

  test "does not expose internal database diagnostics", %{conn: conn} do
    previous = Application.get_env(:webby, :runtime_status_module)
    Application.put_env(:webby, :runtime_status_module, Webby.TestDegradedRuntimeStatus)
    on_exit(fn -> Application.put_env(:webby, :runtime_status_module, previous) end)

    {:ok, view, _html} = live(conn, ~p"/")

    refute render(view) =~ "<script>alert(1)</script>"
  end

  test "persistently discloses broad all-tabs access until revocation", %{conn: conn} do
    {public_key, _private_key} = :crypto.generate_key(:eddsa, :ed25519)

    {:ok, pairing} =
      Webby.Browsers.request_pairing(%{
        "display_name" => "Broad Chrome",
        "extension_id" => "dddddddddddddddddddddddddddddddd",
        "public_key" => Base.url_encode64(public_key, padding: false),
        "scanning_mode" => "all_tabs"
      })

    {:ok, browser} = Webby.Browsers.approve_pairing(pairing.id)
    {:ok, view, _html} = live(conn, ~p"/")
    assert has_element?(view, "#all-tabs-disclosure", "Broad tab scanning is enabled")

    view |> element("#browser-#{browser.id} button", "Revoke") |> render_click()
    refute has_element?(view, "#all-tabs-disclosure")
  end
end
