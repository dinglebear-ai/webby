defmodule WebbyWeb.BrowserChannelTest do
  use Webby.DataCase, async: false
  import Phoenix.ChannelTest

  @endpoint WebbyWeb.Endpoint

  test "an extension can submit a pairing request but cannot self-approve" do
    extension_id = "abcdefghijklmnopabcdefghijklmnop"
    {public_key, _private_key} = :crypto.generate_key(:eddsa, :ed25519)

    assert {:ok, socket} = connect(WebbyWeb.BrowserSocket, %{"extension_id" => extension_id})

    assert {:ok, _, socket} =
             subscribe_and_join(
               socket,
               WebbyWeb.BrowserChannel,
               "browser:pairing:#{extension_id}",
               %{}
             )

    ref =
      push(socket, "message", %{
        "protocol_version" => 1,
        "type" => "pairing.request",
        "request_id" => "request-1",
        "payload" => %{
          "display_name" => "Chrome",
          "public_key" => Base.url_encode64(public_key, padding: false),
          "scanning_mode" => "granted_sites"
        }
      })

    assert_reply ref, :ok, %{"type" => "pairing.pending", "request_id" => "request-1"}

    assert [%{status: "pending", extension_id: ^extension_id}] =
             Webby.Browsers.list_pending_pairings()

    assert Webby.Browsers.list_browsers() == []

    malformed_ref =
      push(socket, "message", %{
        "protocol_version" => 1,
        "type" => "auth.respond",
        "payload" => %{"challenge_id" => "missing-signature"}
      })

    assert_reply malformed_ref, :error, %{"kind" => "invalid_payload"}

    [pairing] = Webby.Browsers.list_pending_pairings()
    assert {:ok, browser} = Webby.Browsers.approve_pairing(pairing.id)
    assert_push "message", %{"type" => "pairing.approved", "payload" => %{browser_id: browser_id}}
    assert browser_id == browser.id

    status_ref =
      push(socket, "message", %{
        "protocol_version" => 1,
        "type" => "pairing.status",
        "request_id" => "status-1",
        "payload" => %{"pairing_id" => pairing.id}
      })

    assert_reply status_ref, :ok, %{
      "type" => "pairing.status",
      "payload" => %{status: "approved", browser_id: ^browser_id}
    }
  end

  test "a connected extension receives a local rejection decision" do
    extension_id = "gggggggggggggggggggggggggggggggg"
    {public_key, _private_key} = :crypto.generate_key(:eddsa, :ed25519)
    assert {:ok, socket} = connect(WebbyWeb.BrowserSocket, %{"extension_id" => extension_id})

    assert {:ok, _, _socket} =
             subscribe_and_join(
               socket,
               WebbyWeb.BrowserChannel,
               "browser:pairing:#{extension_id}",
               %{}
             )

    {:ok, pairing} =
      Webby.Browsers.request_pairing(%{
        "display_name" => "Rejected Chrome",
        "extension_id" => extension_id,
        "public_key" => Base.url_encode64(public_key, padding: false),
        "scanning_mode" => "granted_sites"
      })

    assert {:ok, _request} = Webby.Browsers.reject_pairing(pairing.id)
    assert_push "message", %{"type" => "pairing.rejected", "payload" => %{pairing_id: id}}
    assert id == pairing.id
  end

  test "rejects an invalid extension identity" do
    assert :error = connect(WebbyWeb.BrowserSocket, %{"extension_id" => "not-an-extension"})
  end

  test "origin policy allows Chrome extensions and rejects ordinary web origins" do
    assert WebbyWeb.BrowserOrigin.allowed?(%URI{
             scheme: "chrome-extension",
             host: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
           })

    refute WebbyWeb.BrowserOrigin.allowed?(%URI{scheme: "https", host: "evil.example"})
  end

  test "a paired extension authenticates its channel with the issued challenge" do
    extension_id = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    {public_key, private_key} = :crypto.generate_key(:eddsa, :ed25519)

    {:ok, pairing} =
      Webby.Browsers.request_pairing(%{
        "display_name" => "Authenticated Chrome",
        "extension_id" => extension_id,
        "public_key" => Base.url_encode64(public_key, padding: false),
        "scanning_mode" => "granted_sites"
      })

    {:ok, browser} = Webby.Browsers.approve_pairing(pairing.id)

    assert {:ok, socket} =
             connect(WebbyWeb.BrowserSocket, %{
               "extension_id" => extension_id,
               "browser_id" => browser.id
             })

    assert {:ok, %{"type" => "auth.challenge", "payload" => challenge}, socket} =
             subscribe_and_join(socket, WebbyWeb.BrowserChannel, "browser:auth", %{
               "browser_id" => browser.id
             })

    signature =
      :crypto.sign(:eddsa, :none, challenge.signed_message, [private_key, :ed25519])
      |> Base.url_encode64(padding: false)

    ref =
      push(socket, "message", %{
        "protocol_version" => 1,
        "type" => "auth.respond",
        "payload" => %{
          "challenge_id" => challenge.challenge_id,
          "signature" => signature
        }
      })

    assert_reply ref, :ok, %{"type" => "auth.accepted", "browser_id" => browser_id}
    assert browser_id == browser.id

    hello_ref =
      push(socket, "message", %{
        "protocol_version" => 1,
        "type" => "browser.hello",
        "request_id" => "hello-1",
        "payload" => %{}
      })

    assert_reply hello_ref, :ok, %{
      "type" => "browser.welcome",
      "payload" => %{"resync_required" => true, "heartbeat_interval_ms" => 30_000}
    }

    settings_ref =
      push(socket, "message", %{
        "protocol_version" => 1,
        "type" => "browser.settings",
        "request_id" => "settings-1",
        "payload" => %{"scanning_mode" => "all_tabs", "scanning_paused" => false}
      })

    assert_reply settings_ref, :ok, %{"type" => "acknowledgement"}
    assert %{scanning_mode: "all_tabs"} = Webby.Repo.get!(Webby.Browsers.Browser, browser.id)

    discovery_ref =
      push(socket, "message", %{
        "protocol_version" => 1,
        "type" => "browser.resync",
        "request_id" => "resync-1",
        "payload" => %{
          "observations" => [
            %{
              "url" => "https://example.com/tools?token=secret",
              "title" => "Tools",
              "tools" => [
                %{"name" => "search", "description" => "Search", "input_schema" => %{}}
              ]
            }
          ]
        }
      })

    assert_reply discovery_ref, :ok, %{
      "type" => "acknowledgement",
      "payload" => %{"received" => "browser.resync", "observation_count" => 1}
    }

    assert [%{origin: "https://example.com", sanitized_path: "/tools"}] =
             Webby.Discovery.list_discoveries()
  end

  test "an unauthenticated browser cannot submit discoveries" do
    extension_id = "hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh"
    assert {:ok, socket} = connect(WebbyWeb.BrowserSocket, %{"extension_id" => extension_id})

    assert {:ok, _, socket} =
             subscribe_and_join(
               socket,
               WebbyWeb.BrowserChannel,
               "browser:pairing:#{extension_id}",
               %{}
             )

    ref =
      push(socket, "message", %{
        "protocol_version" => 1,
        "type" => "discovery.observed",
        "payload" => %{
          "observations" => [
            %{
              "url" => "https://example.com",
              "title" => "Tools",
              "tools" => [%{"name" => "search", "input_schema" => %{}}]
            }
          ]
        }
      })

    assert_reply ref, :error, %{kind: "not_ready"}
    assert Webby.Discovery.list_discoveries() == []
  end
end
