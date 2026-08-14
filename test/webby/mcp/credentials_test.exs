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
end
