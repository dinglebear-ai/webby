defmodule Webby.BrowsersTest do
  use Webby.DataCase, async: false

  alias Webby.Browsers
  alias Webby.Browsers.{AuthChallenge, PairingRequest}

  test "approval persists a browser and authentication challenges are single-use" do
    {public_key, private_key} = :crypto.generate_key(:eddsa, :ed25519)
    request = pairing_request(public_key)

    assert {:ok, browser} = Browsers.approve_pairing(request.id)
    assert browser.extension_id == "abcdefghijklmnopabcdefghijklmnop"
    assert {:ok, challenge} = Browsers.issue_challenge(browser.id, browser.extension_id)

    signature =
      :crypto.sign(:eddsa, :none, challenge.signed_message, [private_key, :ed25519])
      |> Base.url_encode64(padding: false)

    assert {:ok, authenticated} =
             Browsers.authenticate(browser.id, challenge.challenge_id, signature)

    assert authenticated.id == browser.id

    assert {:error, :authentication_failed} =
             Browsers.authenticate(browser.id, challenge.challenge_id, signature)
  end

  test "revoked browsers cannot receive challenges" do
    {public_key, _private_key} = :crypto.generate_key(:eddsa, :ed25519)
    request = pairing_request(public_key)
    {:ok, browser} = Browsers.approve_pairing(request.id)
    Phoenix.PubSub.subscribe(Webby.PubSub, "browser:#{browser.id}")
    assert {:ok, _browser} = Browsers.revoke_browser(browser.id)
    assert_receive %Phoenix.Socket.Broadcast{event: "disconnect", topic: "browser:" <> browser_id}
    assert browser_id == browser.id

    assert {:error, :browser_unavailable} =
             Browsers.issue_challenge(browser.id, browser.extension_id)
  end

  test "invalid keys and all-tabs requests remain unapproved until local consent" do
    assert {:error, :invalid_public_key} = Browsers.request_pairing(%{"public_key" => "bad"})
    {public_key, _private_key} = :crypto.generate_key(:eddsa, :ed25519)
    request = pairing_request(public_key, "all_tabs")
    assert request.status == "pending"
    assert Browsers.list_browsers() == []
  end

  test "expired pairing requests cannot be approved" do
    {public_key, _private_key} = :crypto.generate_key(:eddsa, :ed25519)

    request =
      %PairingRequest{}
      |> PairingRequest.changeset(%{
        display_name: "Expired Chrome",
        extension_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        public_key: public_key,
        scanning_mode: "granted_sites",
        status: "pending",
        expires_at: DateTime.utc_now() |> DateTime.add(-1, :second) |> DateTime.truncate(:second)
      })
      |> Repo.insert!()

    assert {:error, :expired} = Browsers.approve_pairing(request.id)
  end

  test "an extension can replace its expired pairing request" do
    {public_key, _private_key} = :crypto.generate_key(:eddsa, :ed25519)

    expired =
      %PairingRequest{}
      |> PairingRequest.changeset(%{
        display_name: "Expired Chrome",
        extension_id: "cccccccccccccccccccccccccccccccc",
        public_key: public_key,
        scanning_mode: "granted_sites",
        status: "pending",
        expires_at: DateTime.utc_now() |> DateTime.add(-1, :second) |> DateTime.truncate(:second)
      })
      |> Repo.insert!()

    assert {:ok, fresh} =
             Browsers.request_pairing(%{
               "display_name" => "Fresh Chrome",
               "extension_id" => expired.extension_id,
               "public_key" => Base.url_encode64(public_key, padding: false),
               "scanning_mode" => "granted_sites"
             })

    assert fresh.id != expired.id
    assert Repo.get!(PairingRequest, expired.id).status == "expired"
  end

  test "an active browser cannot open another pairing request" do
    {public_key, _private_key} = :crypto.generate_key(:eddsa, :ed25519)
    request = pairing_request(public_key)
    {:ok, browser} = Browsers.approve_pairing(request.id)

    assert {:error, :already_paired} =
             Browsers.request_pairing(%{
               "display_name" => "Duplicate Chrome",
               "extension_id" => browser.extension_id,
               "public_key" => Base.url_encode64(public_key, padding: false),
               "scanning_mode" => "granted_sites"
             })
  end

  test "status lookup durably marks an expired request" do
    {public_key, _private_key} = :crypto.generate_key(:eddsa, :ed25519)

    request =
      %PairingRequest{}
      |> PairingRequest.changeset(%{
        display_name: "Expired Chrome",
        extension_id: "ffffffffffffffffffffffffffffffff",
        public_key: public_key,
        scanning_mode: "granted_sites",
        status: "pending",
        expires_at: DateTime.utc_now() |> DateTime.add(-1, :second) |> DateTime.truncate(:second)
      })
      |> Repo.insert!()

    assert {:ok, %{status: "expired"}} = Browsers.pairing_status(request.id, request.extension_id)
    assert Repo.get!(PairingRequest, request.id).status == "expired"
  end

  test "challenge issuance prunes expired rows and reuses one live challenge" do
    {public_key, _private_key} = :crypto.generate_key(:eddsa, :ed25519)
    request = pairing_request(public_key)
    {:ok, browser} = Browsers.approve_pairing(request.id)

    expired =
      %AuthChallenge{}
      |> AuthChallenge.changeset(%{
        browser_id: browser.id,
        nonce: :crypto.strong_rand_bytes(32),
        instance_id: "test-instance-id",
        expires_at: DateTime.utc_now() |> DateTime.add(-1, :second) |> DateTime.truncate(:second)
      })
      |> Repo.insert!()

    assert {:ok, first} = Browsers.issue_challenge(browser.id, browser.extension_id)
    refute Repo.get(AuthChallenge, expired.id)

    assert {:ok, second} = Browsers.issue_challenge(browser.id, browser.extension_id)
    assert second.challenge_id == first.challenge_id
    assert Repo.aggregate(AuthChallenge, :count) == 1
  end

  test "instance rollover rejects and deletes the old challenge before issuing a new one" do
    previous = Application.get_env(:webby, :instance_id_provider)
    instance = start_supervised!({Agent, fn -> "instance-a" end})
    Application.put_env(:webby, :instance_id_provider, fn -> Agent.get(instance, & &1) end)

    on_exit(fn ->
      if previous,
        do: Application.put_env(:webby, :instance_id_provider, previous),
        else: Application.delete_env(:webby, :instance_id_provider)
    end)

    {public_key, private_key} = :crypto.generate_key(:eddsa, :ed25519)
    {:ok, browser} = public_key |> pairing_request() |> then(&Browsers.approve_pairing(&1.id))
    assert {:ok, old_challenge} = Browsers.issue_challenge(browser.id, browser.extension_id)

    old_signature =
      :crypto.sign(:eddsa, :none, old_challenge.signed_message, [private_key, :ed25519])
      |> Base.url_encode64(padding: false)

    Agent.update(instance, fn _ -> "instance-b" end)

    assert {:error, :authentication_failed} =
             Browsers.authenticate(browser.id, old_challenge.challenge_id, old_signature)

    refute Repo.get(AuthChallenge, old_challenge.challenge_id)
    assert {:ok, new_challenge} = Browsers.issue_challenge(browser.id, browser.extension_id)
    assert new_challenge.instance_id == "instance-b"
    assert new_challenge.challenge_id != old_challenge.challenge_id

    new_signature =
      :crypto.sign(:eddsa, :none, new_challenge.signed_message, [private_key, :ed25519])
      |> Base.url_encode64(padding: false)

    assert {:ok, %{id: browser_id}} =
             Browsers.authenticate(browser.id, new_challenge.challenge_id, new_signature)

    assert browser_id == browser.id
  end

  test "pairing admission is bounded" do
    previous = Application.get_env(:webby, :max_pending_pairings)
    Application.put_env(:webby, :max_pending_pairings, 1)

    on_exit(fn ->
      if previous,
        do: Application.put_env(:webby, :max_pending_pairings, previous),
        else: Application.delete_env(:webby, :max_pending_pairings)
    end)

    {public_key, _private_key} = :crypto.generate_key(:eddsa, :ed25519)
    pairing_request(public_key)

    assert {:error, :too_many_pending_pairings} =
             Browsers.request_pairing(%{
               "display_name" => "Second Chrome",
               "extension_id" => "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
               "public_key" => Base.url_encode64(public_key, padding: false),
               "scanning_mode" => "granted_sites"
             })
  end

  defp pairing_request(public_key, mode \\ "granted_sites") do
    {:ok, request} =
      Browsers.request_pairing(%{
        "display_name" => "Work Chrome",
        "extension_id" => "abcdefghijklmnopabcdefghijklmnop",
        "public_key" => Base.url_encode64(public_key, padding: false),
        "scanning_mode" => mode
      })

    request
  end
end
