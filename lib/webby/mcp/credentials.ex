defmodule Webby.MCP.Credentials do
  @moduledoc "Hashed, independently revocable MCP client credentials."

  import Ecto.Query
  alias Webby.MCP.Credential
  alias Webby.Repo

  @token_bytes 32

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

  def authenticate(token) when is_binary(token) do
    token_hash = hash(token)

    case Repo.one(
           from c in Credential, where: c.token_hash == ^token_hash and is_nil(c.revoked_at)
         ) do
      %Credential{} = credential ->
        now = DateTime.utc_now() |> DateTime.truncate(:second)

        {1, _} =
          Repo.update_all(from(c in Credential, where: c.id == ^credential.id),
            set: [last_used_at: now]
          )

        {:ok, credential}

      nil ->
        {:error, :invalid_credential}
    end
  end

  def authenticate(_token), do: {:error, :invalid_credential}

  def scope?(%Credential{scopes: %{"values" => scopes}}, scope), do: scope in scopes

  def revoke(id) do
    case Repo.get(Credential, id) do
      nil -> {:error, :not_found}
      credential -> credential |> Credential.changeset(%{revoked_at: now()}) |> Repo.update()
    end
  end

  defp hash(token), do: :crypto.hash(:sha256, token)
  defp now, do: DateTime.utc_now() |> DateTime.truncate(:second)
end
