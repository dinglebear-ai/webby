defmodule WebbyWeb.E2EPersistenceControllerTest do
  use WebbyWeb.ConnCase, async: false

  alias Webby.Browsers.Browser
  alias Webby.Repo

  setup do
    previous_marker = System.get_env("WEBBY_ENVIRONMENT_MARKER")
    previous_hash = System.get_env("WEBBY_E2E_TELEMETRY_CAPABILITY_HASH")

    on_exit(fn ->
      restore_env("WEBBY_ENVIRONMENT_MARKER", previous_marker)
      restore_env("WEBBY_E2E_TELEMETRY_CAPABILITY_HASH", previous_hash)
    end)

    :ok
  end

  test "POST /e2e/persistence is unavailable outside an isolated world", %{conn: conn} do
    System.delete_env("WEBBY_ENVIRONMENT_MARKER")

    response =
      conn
      |> put_req_header("x-webby-e2e-capability", "untrusted")
      |> post(~p"/e2e/persistence", %{
        op: "browser.erase",
        browser_id: Ecto.UUID.generate(),
        audits: "delete"
      })
      |> json_response(404)

    assert response == %{"error" => "not_found"}
  end

  test "POST /e2e/persistence erases through the running application", %{conn: conn} do
    capability = "isolated-capability"
    System.put_env("WEBBY_ENVIRONMENT_MARKER", "isolated-e2e")
    System.put_env("WEBBY_E2E_TELEMETRY_CAPABILITY_HASH", sha256(capability))
    browser = insert_browser()

    response =
      conn
      |> put_req_header("x-webby-e2e-capability", capability)
      |> post(~p"/e2e/persistence", %{
        op: "browser.erase",
        browser_id: browser.id,
        audits: "anonymize"
      })
      |> json_response(200)

    assert response["status"] == "ok"
    assert response["result"]["browser_id"] == browser.id
    refute Repo.get(Browser, browser.id)
  end

  defp insert_browser do
    {public_key, _private_key} = :crypto.generate_key(:eddsa, :ed25519)

    %Browser{}
    |> Browser.changeset(%{
      display_name: "Controller browser",
      extension_id: "controllerextensionidentifier",
      public_key: public_key,
      scanning_mode: "granted_sites",
      paired_at: DateTime.utc_now() |> DateTime.truncate(:second)
    })
    |> Repo.insert!()
  end

  defp sha256(value), do: :crypto.hash(:sha256, value) |> Base.encode16(case: :lower)
  defp restore_env(name, nil), do: System.delete_env(name)
  defp restore_env(name, value), do: System.put_env(name, value)
end
