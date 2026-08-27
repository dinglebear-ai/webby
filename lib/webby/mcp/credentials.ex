defmodule Webby.MCP.Credentials do
  @moduledoc "Hashed, independently revocable MCP client credentials."

  import Ecto.Query
  alias Webby.MCP.Credential
  alias Webby.Repo

  @token_bytes 32
  @last_used_write_interval_seconds 60

  def list, do: Repo.all(from c in Credential, order_by: [desc: c.inserted_at])

  def create(display_name, scopes \\ ["read"]) when is_binary(display_name) do
    token =
      "webby_" <> (:crypto.strong_rand_bytes(@token_bytes) |> Base.url_encode64(padding: false))

    case %Credential{}
         |> Credential.changeset(%{
           display_name: display_name,
           token_hash: hash(token),
           scopes: %{"values" => Enum.uniq(scopes)}
         })
         |> Repo.insert() do
      {:ok, credential} -> {:ok, credential, token}
      error -> error
    end
  end

  def authenticate(token) when is_binary(token), do: authenticate(token, [])
  def authenticate(_token), do: {:error, :invalid_credential}

  @doc false
  def authenticate(token, options) when is_binary(token) and is_list(options) do
    token_hash = hash(token)
    now = now()
    cutoff = DateTime.add(now, -@last_used_write_interval_seconds, :second)
    after_write = Keyword.get(options, :after_write, fn -> :ok end)

    Repo.transaction(fn -> authenticate_in_transaction(token_hash, now, cutoff, after_write) end)
    |> normalize_authentication_result()
  end

  def scope?(%Credential{scopes: %{"values" => scopes}}, scope), do: scope in scopes

  def revoke(id) do
    timestamp = now()

    case Repo.update_all(
           from(c in Credential, where: c.id == ^id and is_nil(c.revoked_at)),
           set: [revoked_at: timestamp, updated_at: timestamp]
         ) do
      {1, _} ->
        {:ok, Repo.get!(Credential, id)}

      {0, _} ->
        if Repo.get(Credential, id), do: {:error, :already_revoked}, else: {:error, :not_found}
    end
  end

  defp hash(token), do: :crypto.hash(:sha256, token)
  defp now, do: DateTime.utc_now() |> DateTime.truncate(:second)

  defp authenticate_in_transaction(token_hash, now, cutoff, after_write) do
    stale_query =
      from c in Credential,
        where:
          c.token_hash == ^token_hash and is_nil(c.revoked_at) and
            (is_nil(c.last_used_at) or c.last_used_at <= ^cutoff)

    update_result = Repo.update_all(stale_query, set: [last_used_at: now])
    after_write.()
    fetch_authenticated_credential(update_result, token_hash)
  end

  defp fetch_authenticated_credential({1, _}, token_hash),
    do: Repo.one!(from c in Credential, where: c.token_hash == ^token_hash)

  defp fetch_authenticated_credential({0, _}, token_hash) do
    Repo.one(from c in Credential, where: c.token_hash == ^token_hash and is_nil(c.revoked_at)) ||
      Repo.rollback(:invalid_credential)
  end

  defp normalize_authentication_result({:ok, credential}), do: {:ok, credential}

  defp normalize_authentication_result({:error, :invalid_credential}),
    do: {:error, :invalid_credential}
end
