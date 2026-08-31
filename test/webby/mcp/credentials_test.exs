defmodule Webby.MCP.CredentialsTest do
  use Webby.DataCase, async: false

  alias Webby.MCP.Credentials

  test "stores only a token hash and enforces scopes" do
    assert {:ok, credential, "webby_" <> _secret = token} = Credentials.create("Claude", ["read"])
    refute credential.token_hash == token
    assert byte_size(credential.token_hash) == 32

    assert {:ok, authenticated} = Credentials.authenticate(token)
    assert authenticated.id == credential.id
    assert Credentials.scope?(authenticated, "read")
    refute Credentials.scope?(authenticated, "admin")
    assert {:error, :invalid_credential} = Credentials.authenticate(token <> "wrong")

    assert {:ok, _revoked} = Credentials.revoke(credential.id)
    assert {:error, :invalid_credential} = Credentials.authenticate(token)
  end

  test "throttles last-used writes and revocation is idempotently terminal" do
    assert {:ok, credential, token} = Credentials.create("Claude")
    assert {:ok, first} = Credentials.authenticate(token)
    assert %DateTime{} = first.last_used_at

    assert {:ok, second} = Credentials.authenticate(token)
    assert second.last_used_at == first.last_used_at

    assert {:ok, revoked} = Credentials.revoke(credential.id)
    assert %DateTime{} = revoked.revoked_at
    assert {:error, :already_revoked} = Credentials.revoke(credential.id)
    assert {:error, :invalid_credential} = Credentials.authenticate(token)
  end

  test "read-only authentication validates without opening a last-used write" do
    assert {:ok, credential, token} = Credentials.create("Cancellation client")
    assert is_nil(credential.last_used_at)

    assert {:ok, authenticated} = Credentials.authenticate(token, touch: false)
    assert authenticated.id == credential.id
    assert is_nil(authenticated.last_used_at)

    assert {:ok, _revoked} = Credentials.revoke(credential.id)
    assert {:error, :invalid_credential} = Credentials.authenticate(token, touch: false)
  end

  test "revocation waits for an in-flight authentication and remains terminal" do
    assert {:ok, credential, token} = Credentials.create("Concurrent client")
    test_pid = self()

    authenticator =
      Task.async(fn ->
        Credentials.authenticate(token,
          after_write: fn ->
            send(test_pid, :authentication_wrote)
            assert_receive :finish_authentication
          end
        )
      end)

    assert_receive :authentication_wrote

    revoker =
      Task.async(fn ->
        send(test_pid, :revocation_started)
        Credentials.revoke(credential.id)
      end)

    assert_receive :revocation_started
    refute Task.yield(revoker, 50)

    send(authenticator.pid, :finish_authentication)

    assert {:ok, authenticated} = Task.await(authenticator)
    assert authenticated.id == credential.id
    assert {:ok, revoked} = Task.await(revoker)
    assert %DateTime{} = revoked.revoked_at

    assert {:error, :invalid_credential} = Credentials.authenticate(token)
  end

  test "authentication completed before revocation cannot dispatch after revocation returns" do
    browser_id = Ecto.UUID.generate()
    assert :ok = Webby.BrowserConnections.register(browser_id, self())
    assert {:ok, credential, token} = Credentials.create("Admission race", ["call"])
    assert {:ok, authenticated} = Credentials.authenticate(token)
    assert authenticated.id == credential.id

    assert {:ok, _revoked} = Credentials.revoke(credential.id)

    assert {:error, "revoked", _message} =
             Webby.BrowserConnections.call(
               browser_id,
               %{"tool_name" => "must-not-run"},
               100,
               {credential.id, "late-admission"},
               nil,
               credential.id
             )

    refute_receive {:tool_call, _payload}
  end

  test "blocked and failed credential persistence cannot stall or crash unrelated browser traffic" do
    first_browser = Ecto.UUID.generate()
    second_browser = Ecto.UUID.generate()
    credential_id = Ecto.UUID.generate()
    assert :ok = Webby.BrowserConnections.register(first_browser, self())
    assert :ok = Webby.BrowserConnections.register(second_browser, self())
    parent = self()

    revoker =
      Task.async(fn ->
        Credentials.revoke(credential_id,
          persist: fn ^credential_id ->
            send(parent, :persistence_blocked)
            assert_receive :release_persistence
            {:error, :not_found}
          end
        )
      end)

    assert_receive :persistence_blocked

    unrelated =
      Task.async(fn ->
        Webby.BrowserConnections.call(second_browser, %{"unrelated" => true}, 500)
      end)

    assert_receive {:tool_call, %{"call_id" => call_id, "unrelated" => true}}

    Webby.BrowserConnections.complete(second_browser, %{
      "type" => "tool.result",
      "call_id" => call_id,
      "result" => "ok"
    })

    assert {:ok, "ok"} = Task.await(unrelated)
    send(revoker.pid, :release_persistence)
    assert {:error, :not_found} = Task.await(revoker)

    assert_raise RuntimeError, "database exploded", fn ->
      Credentials.revoke(credential_id,
        persist: fn ^credential_id -> raise "database exploded" end
      )
    end

    assert Process.alive?(Process.whereis(Webby.BrowserConnections))
    assert :ok = Webby.BrowserConnections.register(first_browser, self())
  end

  test "throwing and exiting persistence release the credential denial barrier" do
    browser_id = Ecto.UUID.generate()
    assert :ok = Webby.BrowserConnections.register(browser_id, self())

    for {kind, failure} <- [
          {:throw, fn -> throw(:persistence_threw) end},
          {:exit, fn -> exit(:persistence_exited) end}
        ] do
      credential_id = Ecto.UUID.generate()

      case kind do
        :throw ->
          assert catch_throw(
                   Credentials.revoke(credential_id, persist: fn ^credential_id -> failure.() end)
                 ) ==
                   :persistence_threw

        :exit ->
          assert catch_exit(
                   Credentials.revoke(credential_id, persist: fn ^credential_id -> failure.() end)
                 ) ==
                   :persistence_exited
      end

      call =
        Task.async(fn ->
          Webby.BrowserConnections.call(browser_id, %{}, 500, nil, nil, credential_id)
        end)

      assert_receive {:tool_call, %{"call_id" => call_id}}

      Webby.BrowserConnections.complete(browser_id, %{
        "type" => "tool.result",
        "call_id" => call_id,
        "result" => "allowed"
      })

      assert {:ok, "allowed"} = Task.await(call)
    end
  end

  test "a committed revocation cannot be undone by a concurrent revoker aborting" do
    browser_id = Ecto.UUID.generate()
    credential_id = Ecto.UUID.generate()
    parent = self()
    assert :ok = Webby.BrowserConnections.register(browser_id, self())

    first =
      Task.async(fn ->
        Credentials.revoke(credential_id,
          persist: fn ^credential_id ->
            send(parent, {:revoker_ready, :committing})
            assert_receive :commit, 5_000
            {:ok, %{id: credential_id}}
          end
        )
      end)

    assert_receive {:revoker_ready, :committing}

    second =
      Task.async(fn ->
        Credentials.revoke(credential_id,
          persist: fn ^credential_id ->
            send(parent, {:revoker_ready, :aborting})
            assert_receive :abort, 5_000
            {:error, :already_revoked}
          end
        )
      end)

    assert_receive {:revoker_ready, :aborting}

    assert {:error, "revoked", _message} =
             Webby.BrowserConnections.call(
               browser_id,
               %{"tool_name" => "blocked-during-revocation"},
               100,
               {credential_id, "paused-call"},
               nil,
               credential_id
             )

    refute_receive {:tool_call, %{"tool_name" => "blocked-during-revocation"}}
    send(first.pid, :commit)
    assert {:ok, %{id: ^credential_id}} = Task.await(first)
    send(second.pid, :abort)
    assert {:error, :already_revoked} = Task.await(second)

    assert {:error, "revoked", _message} =
             Webby.BrowserConnections.call(
               browser_id,
               %{"tool_name" => "blocked-after-abort"},
               100,
               {credential_id, "late-call"},
               nil,
               credential_id
             )

    refute_receive {:tool_call, %{"tool_name" => "blocked-after-abort"}}
  end
end
