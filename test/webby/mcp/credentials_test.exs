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
end
