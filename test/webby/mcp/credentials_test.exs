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

  test "concurrent authentication cannot resurrect a revoked credential" do
    assert {:ok, credential, token} = Credentials.create("Concurrent client")

    authenticators =
      for _ <- 1..8 do
        Task.async(fn -> Credentials.authenticate(token) end)
      end

    assert {:ok, _revoked} = Credentials.revoke(credential.id)
    Enum.each(authenticators, &Task.await/1)

    for _ <- 1..8 do
      assert {:error, :invalid_credential} = Credentials.authenticate(token)
    end
  end
end
