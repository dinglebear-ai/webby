defmodule Webby.Browsers do
  @moduledoc "Durable browser pairing and challenge authentication."

  import Ecto.Query
  alias Ecto.Multi
  alias Webby.Browsers.{AuthChallenge, Browser, PairingRequest}
  alias Webby.{Pages, Repo}

  @pairing_ttl 300
  @challenge_ttl 60

  def list_browsers, do: Repo.all(from b in Browser, order_by: [asc: b.display_name])

  def list_pending_pairings do
    now = now()

    Repo.all(
      from p in PairingRequest,
        where: p.status == "pending" and p.expires_at > ^now,
        order_by: [asc: p.inserted_at]
    )
  end

  def request_pairing(attrs) do
    with {:ok, public_key} <- decode_public_key(attrs["public_key"] || attrs[:public_key]) do
      attrs =
        attrs
        |> Map.new(fn {key, value} -> {to_string(key), value} end)
        |> Map.put("public_key", public_key)
        |> Map.put("status", "pending")
        |> Map.put("expires_at", DateTime.add(now(), @pairing_ttl, :second))

      Repo.transaction(fn ->
        expire_stale_pairings()
        enforce_pairing_capacity!()
        ensure_not_paired!(attrs["extension_id"])
        insert_pairing!(attrs)
      end)
    end
  end

  def approve_pairing(id) do
    now = now()

    Multi.new()
    |> Multi.run(:request, fn repo, _ -> pending_request(repo, id, now) end)
    |> Multi.insert(:browser, fn %{request: request} ->
      Browser.changeset(%Browser{}, %{
        display_name: request.display_name,
        extension_id: request.extension_id,
        public_key: request.public_key,
        scanning_mode: request.scanning_mode,
        paired_at: now
      })
    end)
    |> Multi.update(:resolved, fn %{request: request, browser: browser} ->
      request
      |> PairingRequest.changeset(%{status: "approved", resolved_at: now})
      |> Ecto.Changeset.put_change(:browser_id, browser.id)
    end)
    |> Repo.transaction()
    |> case do
      {:ok, %{request: request, browser: browser}} ->
        notify_pairing(request.extension_id, "approved", request.id, browser.id)
        {:ok, browser}

      {:error, _step, reason, _changes} ->
        {:error, reason}
    end
  end

  def reject_pairing(id) do
    case resolve_pairing(id, "rejected") do
      {:ok, request} ->
        notify_pairing(request.extension_id, "rejected", request.id, nil)
        {:ok, request}

      error ->
        error
    end
  end

  def pairing_status(id, extension_id) do
    case Repo.get_by(PairingRequest, id: id, extension_id: extension_id) do
      nil ->
        {:error, :not_found}

      request ->
        request |> expire_pairing_if_needed() |> pairing_status_payload() |> then(&{:ok, &1})
    end
  end

  def revoke_browser(id) do
    case Repo.get(Browser, id) do
      nil ->
        {:error, :not_found}

      browser ->
        case revoke_and_close(browser) do
          {:ok, revoked} ->
            WebbyWeb.Endpoint.broadcast("browser:#{browser.id}", "disconnect", %{})
            {:ok, revoked}

          error ->
            error
        end
    end
  end

  def update_scanning(browser_id, mode, paused)
      when mode in ["granted_sites", "all_tabs"] and is_boolean(paused) do
    case Repo.get(Browser, browser_id) do
      %Browser{revoked_at: nil} = browser ->
        update_scanning_and_sessions(browser, mode, paused)

      _browser ->
        {:error, :browser_unavailable}
    end
  end

  def update_scanning(_browser_id, _mode, _paused), do: {:error, :invalid_scanning_settings}

  def issue_challenge(browser_id, extension_id) do
    with :ok <- Webby.BrowserConnections.browser_admissible?(browser_id) do
      case Repo.get(Browser, browser_id) do
        %Browser{revoked_at: nil, extension_id: ^extension_id} = browser ->
          instance_id = instance_id()

          Repo.transaction(fn -> issue_or_reuse_challenge(browser.id, instance_id) end)

        _browser ->
          {:error, :browser_unavailable}
      end
    end
  end

  def authenticate(browser_id, challenge_id, encoded_signature) do
    now = now()
    instance_id = instance_id()

    with :ok <- Webby.BrowserConnections.browser_admissible?(browser_id) do
      Repo.transaction(fn ->
        challenge =
          Repo.one(
            from c in AuthChallenge,
              join: b in assoc(c, :browser),
              where:
                c.id == ^challenge_id and c.browser_id == ^browser_id and is_nil(c.used_at) and
                  c.expires_at > ^now and is_nil(b.revoked_at),
              preload: [browser: b]
          )

        with %AuthChallenge{instance_id: ^instance_id} <- challenge,
             {:ok, signature} <- Base.url_decode64(encoded_signature, padding: false),
             true <- verify_signature(challenge, signature),
             {1, _rows} <-
               Repo.delete_all(
                 from c in AuthChallenge, where: c.id == ^challenge.id and is_nil(c.used_at)
               ) do
          challenge.browser |> Browser.changeset(%{last_seen_at: now}) |> Repo.update!()
        else
          %AuthChallenge{} = stale_challenge ->
            Repo.delete!(stale_challenge)
            {:error, :authentication_failed}

          _ ->
            Repo.rollback(:authentication_failed)
        end
      end)
      |> normalize_authentication()
    end
  end

  defp normalize_authentication({:ok, {:error, :authentication_failed}}),
    do: {:error, :authentication_failed}

  defp normalize_authentication(result), do: result

  defp verify_signature(challenge, signature) do
    :crypto.verify(:eddsa, :none, signed_message(challenge), signature, [
      challenge.browser.public_key,
      :ed25519
    ])
  rescue
    _ -> false
  end

  defp revoke_and_close(browser) do
    Repo.transaction(fn ->
      revoked = browser |> Browser.changeset(%{revoked_at: now()}) |> Repo.update!()
      {:ok, _count} = Pages.close_browser_sessions(browser.id, "page.session.browser_revoked")
      revoked
    end)
  end

  defp update_scanning_and_sessions(browser, mode, paused) do
    Repo.transaction(fn ->
      updated =
        browser
        |> Browser.changeset(%{
          scanning_mode: mode,
          scanning_paused: paused,
          last_seen_at: now()
        })
        |> Repo.update!()

      close_sessions_when_paused(browser.id, paused)
      updated
    end)
  end

  defp close_sessions_when_paused(_browser_id, false), do: :ok

  defp close_sessions_when_paused(browser_id, true) do
    {:ok, _count} = Pages.close_browser_sessions(browser_id, "page.session.scanning_paused")
    :ok
  end

  defp signed_message(challenge) do
    [
      "webby-browser-auth-v1",
      challenge.browser_id,
      challenge.id,
      Base.url_encode64(challenge.nonce, padding: false),
      challenge.instance_id
    ]
    |> Enum.join("\n")
  end

  defp challenge_payload(challenge) do
    %{
      challenge_id: challenge.id,
      nonce: Base.url_encode64(challenge.nonce, padding: false),
      instance_id: challenge.instance_id,
      expires_at: DateTime.to_iso8601(challenge.expires_at),
      signed_message: signed_message(challenge)
    }
  end

  defp pending_request(repo, id, now) do
    case repo.get(PairingRequest, id) do
      %PairingRequest{status: "pending", expires_at: expires_at} = request ->
        if DateTime.after?(expires_at, now), do: {:ok, request}, else: {:error, :expired}

      nil ->
        {:error, :not_found}

      _request ->
        {:error, :already_resolved}
    end
  end

  defp resolve_pairing(id, status) do
    now = now()

    with {:ok, request} <- pending_request(Repo, id, now) do
      request |> PairingRequest.changeset(%{status: status, resolved_at: now}) |> Repo.update()
    end
  end

  defp decode_public_key(value) when is_binary(value) do
    case Base.url_decode64(value, padding: false) do
      {:ok, key} when byte_size(key) == 32 -> {:ok, key}
      _ -> {:error, :invalid_public_key}
    end
  end

  defp decode_public_key(_value), do: {:error, :invalid_public_key}

  defp instance_id,
    do:
      Application.get_env(:webby, :instance_id_provider, &Webby.RuntimeDiscovery.instance_id/0).()

  defp expire_stale_pairings do
    now = now()

    Repo.update_all(
      from(p in PairingRequest,
        where: p.status == "pending" and p.expires_at <= ^now
      ),
      set: [status: "expired", resolved_at: now, updated_at: now]
    )
  end

  defp enforce_pairing_capacity! do
    limit = Application.get_env(:webby, :max_pending_pairings, 100)
    pending = Repo.aggregate(from(p in PairingRequest, where: p.status == "pending"), :count)

    if pending >= limit, do: Repo.rollback(:too_many_pending_pairings)
  end

  defp live_challenge(browser_id, instance_id) do
    now = now()

    Repo.one(
      from c in AuthChallenge,
        where:
          c.browser_id == ^browser_id and c.instance_id == ^instance_id and is_nil(c.used_at) and
            c.expires_at > ^now,
        order_by: [desc: c.inserted_at],
        limit: 1
    )
  end

  defp issue_or_reuse_challenge(browser_id, instance_id) do
    case live_challenge(browser_id, instance_id) do
      %AuthChallenge{} = challenge ->
        challenge_payload(challenge)

      nil ->
        Repo.delete_all(from c in AuthChallenge, where: c.browser_id == ^browser_id)
        insert_challenge!(browser_id, instance_id)
    end
  end

  defp insert_challenge!(browser_id, instance_id) do
    case %AuthChallenge{}
         |> AuthChallenge.changeset(%{
           browser_id: browser_id,
           nonce: :crypto.strong_rand_bytes(32),
           instance_id: instance_id,
           expires_at: DateTime.add(now(), @challenge_ttl, :second)
         })
         |> Repo.insert() do
      {:ok, challenge} -> challenge_payload(challenge)
      {:error, reason} -> Repo.rollback(reason)
    end
  end

  defp insert_pairing!(attrs) do
    case %PairingRequest{} |> PairingRequest.changeset(attrs) |> Repo.insert() do
      {:ok, request} -> request
      {:error, reason} -> Repo.rollback(reason)
    end
  end

  defp ensure_not_paired!(extension_id) do
    if Repo.exists?(
         from b in Browser, where: b.extension_id == ^extension_id and is_nil(b.revoked_at)
       ) do
      Repo.rollback(:already_paired)
    end
  end

  defp expire_pairing_if_needed(
         %PairingRequest{status: "pending", expires_at: expires_at} = request
       ) do
    if DateTime.after?(expires_at, now()) do
      request
    else
      request
      |> PairingRequest.changeset(%{status: "expired", resolved_at: now()})
      |> Repo.update!()
    end
  end

  defp expire_pairing_if_needed(request), do: request

  defp notify_pairing(extension_id, status, pairing_id, browser_id) do
    Phoenix.PubSub.broadcast(
      Webby.PubSub,
      "browser_pairing:#{extension_id}",
      {:pairing_resolved, %{status: status, pairing_id: pairing_id, browser_id: browser_id}}
    )
  end

  defp pairing_status_payload(request) do
    %{status: request.status, pairing_id: request.id, browser_id: request.browser_id}
  end

  defp now, do: DateTime.utc_now() |> DateTime.truncate(:second)
end
