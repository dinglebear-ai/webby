defmodule Webby.MCP.Credentials do
  @moduledoc "Hashed, independently revocable MCP client credentials."

  import Ecto.Query
  require Logger
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

    if Keyword.get(options, :touch, true) do
      authenticate_and_touch(token_hash, options)
    else
      case Repo.one(
             from c in Credential,
               where: c.token_hash == ^token_hash and is_nil(c.revoked_at)
           ) do
        nil -> {:error, :invalid_credential}
        credential -> {:ok, credential}
      end
    end
  end

  defp authenticate_and_touch(token_hash, options) do
    now = now()
    cutoff = DateTime.add(now, -@last_used_write_interval_seconds, :second)
    after_write = Keyword.get(options, :after_write, fn -> :ok end)

    Repo.transaction(fn -> authenticate_in_transaction(token_hash, now, cutoff, after_write) end)
    |> normalize_authentication_result()
  end

  def scope?(%Credential{scopes: %{"values" => scopes}}, scope), do: scope in scopes

  def active?(id) do
    if Repo.exists?(from c in Credential, where: c.id == ^id and is_nil(c.revoked_at)),
      do: :ok,
      else: {:error, :revoked}
  rescue
    _exception in DBConnection.ConnectionError ->
      Logger.warning("credential availability check failed",
        event: "mcp.credential.availability_failed",
        reason: "database_connection_error"
      )

      {:error, :credential_unavailable}
  end

  @doc false
  def revoked?(id) do
    case Repo.get(Credential, id) do
      %Credential{revoked_at: %DateTime{}} -> true
      %Credential{} -> false
      nil -> false
    end
  rescue
    exception in DBConnection.ConnectionError -> {:error, exception}
  end

  def revoke(id, opts \\ []) do
    persist = Keyword.get(opts, :persist, &revoke_persisted/1)
    after_persist = Keyword.get(opts, :after_persist, fn -> :ok end)
    {:ok, barrier_token} = Webby.BrowserConnections.begin_credential_revocation(id)

    try do
      case persist.(id) do
        {:ok, _credential} = result ->
          :ok = after_persist.()

          :ok =
            Webby.BrowserConnections.finish_credential_revocation(id, barrier_token, :committed)

          result

        error ->
          :ok =
            Webby.BrowserConnections.finish_credential_revocation(id, barrier_token, :aborted)

          error
      end
    rescue
      exception ->
        :ok =
          Webby.BrowserConnections.finish_credential_revocation(id, barrier_token, :aborted)

        reraise exception, __STACKTRACE__
    catch
      kind, reason ->
        :ok =
          Webby.BrowserConnections.finish_credential_revocation(id, barrier_token, :aborted)

        :erlang.raise(kind, reason, __STACKTRACE__)
    end
  end

  defp revoke_persisted(id) do
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
