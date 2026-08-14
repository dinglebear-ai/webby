defmodule WebbyWeb.BrowserChannel do
  @moduledoc false
  use WebbyWeb, :channel

  alias Webby.{BrowserProtocol, Browsers, Discovery}
  alias Webby.Discovery.Discovery, as: DiscoveryRecord
  require Logger

  @impl true
  def join("browser:pairing:" <> extension_id, _payload, socket) do
    if extension_id == socket.assigns.extension_id do
      Phoenix.PubSub.subscribe(Webby.PubSub, "browser_pairing:#{extension_id}")
      {:ok, socket}
    else
      {:error, %{kind: "extension_identity_mismatch"}}
    end
  end

  def join("browser:auth", %{"browser_id" => browser_id}, socket) do
    if socket.assigns.browser_id != browser_id do
      {:error, %{kind: "browser_identity_mismatch"}}
    else
      join_authenticated_browser(browser_id, socket)
    end
  end

  defp join_authenticated_browser(browser_id, socket) do
    case Browsers.issue_challenge(browser_id, socket.assigns.extension_id) do
      {:ok, challenge} ->
        {:ok, BrowserProtocol.envelope("auth.challenge", challenge, browser_id: browser_id),
         assign(socket, :browser_id, browser_id)}

      {:error, reason} ->
        {:error, %{kind: error_kind(reason)}}
    end
  end

  @impl true
  def handle_in("message", payload, socket) do
    case BrowserProtocol.validate(payload) do
      {:ok, envelope} -> dispatch(envelope, socket)
      {:error, error} -> {:reply, {:error, error}, socket}
    end
  end

  @impl true
  def handle_info({:pairing_resolved, payload}, socket) do
    push(socket, "message", BrowserProtocol.envelope("pairing.#{payload.status}", payload))
    {:noreply, socket}
  end

  defp dispatch(%{type: "pairing.request", payload: payload, request_id: request_id}, socket) do
    attrs = Map.put(payload, "extension_id", socket.assigns.extension_id)

    case Browsers.request_pairing(attrs) do
      {:ok, request} ->
        response =
          BrowserProtocol.envelope(
            "pairing.pending",
            %{
              "pairing_id" => request.id,
              "expires_at" => DateTime.to_iso8601(request.expires_at)
            },
            request_id: request_id
          )

        {:reply, {:ok, response}, socket}

      {:error, reason} ->
        {:reply, {:error, %{kind: error_kind(reason)}}, socket}
    end
  end

  defp dispatch(
         %{type: "auth.respond", payload: payload},
         %{assigns: %{browser_id: browser_id}} = socket
       ) do
    case Browsers.authenticate(browser_id, payload["challenge_id"], payload["signature"]) do
      {:ok, browser} ->
        response =
          BrowserProtocol.envelope("auth.accepted", %{"browser_id" => browser.id},
            browser_id: browser.id
          )

        {:reply, {:ok, response}, assign(socket, :authenticated, true)}

      {:error, reason} ->
        {:reply, {:error, %{kind: error_kind(reason)}}, socket}
    end
  end

  defp dispatch(%{type: "pairing.status", payload: payload, request_id: request_id}, socket) do
    case Browsers.pairing_status(payload["pairing_id"], socket.assigns.extension_id) do
      {:ok, status} ->
        response = BrowserProtocol.envelope("pairing.status", status, request_id: request_id)
        {:reply, {:ok, response}, socket}

      {:error, reason} ->
        {:reply, {:error, %{kind: error_kind(reason)}}, socket}
    end
  end

  defp dispatch(
         %{type: "browser.hello", request_id: request_id},
         %{assigns: %{authenticated: true}} = socket
       ) do
    response =
      BrowserProtocol.envelope(
        "browser.welcome",
        %{
          "resync_required" => true,
          "heartbeat_interval_ms" => 30_000,
          "ignored_origins" => Discovery.list_ignored_origins(socket.assigns.browser_id)
        },
        request_id: request_id,
        browser_id: socket.assigns.browser_id
      )

    {:reply, {:ok, response}, socket}
  end

  defp dispatch(
         %{type: "heartbeat", request_id: request_id},
         %{assigns: %{authenticated: true}} = socket
       ) do
    response =
      BrowserProtocol.envelope("acknowledgement", %{"received" => "heartbeat"},
        request_id: request_id,
        browser_id: socket.assigns.browser_id
      )

    {:reply, {:ok, response}, socket}
  end

  defp dispatch(
         %{type: "browser.settings", payload: payload, request_id: request_id},
         %{assigns: %{authenticated: true, browser_id: browser_id}} = socket
       ) do
    case Browsers.update_scanning(
           browser_id,
           payload["scanning_mode"],
           payload["scanning_paused"]
         ) do
      {:ok, _browser} ->
        {:reply, {:ok, acknowledgement("browser.settings", request_id, browser_id)}, socket}

      {:error, reason} ->
        {:reply, {:error, %{kind: error_kind(reason)}}, socket}
    end
  end

  defp dispatch(
         %{type: type, payload: %{"observations" => observations}, request_id: request_id},
         %{assigns: %{authenticated: true, browser_id: browser_id}} = socket
       )
       when type in ["discovery.observed", "browser.resync"] do
    case Discovery.observe_many(browser_id, observations) do
      {:ok, discoveries} ->
        Logger.info("browser discovery observations accepted",
          browser_id: browser_id,
          observation_count: accepted_count(discoveries),
          event: type
        )

        response =
          BrowserProtocol.envelope(
            "acknowledgement",
            %{
              "received" => type,
              "observation_count" => accepted_count(discoveries),
              "ignored_origins" => Discovery.list_ignored_origins(browser_id)
            },
            request_id: request_id,
            browser_id: browser_id
          )

        {:reply, {:ok, response}, socket}

      {:error, reason} ->
        {:reply, {:error, %{kind: error_kind(reason)}}, socket}
    end
  end

  defp dispatch(%{type: type}, %{assigns: %{browser_id: browser_id}} = socket)
       when is_binary(browser_id),
       do: {:reply, {:error, %{kind: "authentication_required", type: type}}, socket}

  defp dispatch(%{type: type}, socket),
    do: {:reply, {:error, %{kind: "not_ready", type: type}}, socket}

  defp error_kind(%Ecto.Changeset{}), do: "invalid_request"
  defp error_kind(reason) when is_atom(reason), do: Atom.to_string(reason)
  defp error_kind(_reason), do: "request_failed"

  defp acknowledgement(received, request_id, browser_id) do
    BrowserProtocol.envelope("acknowledgement", %{"received" => received},
      request_id: request_id,
      browser_id: browser_id
    )
  end

  defp accepted_count(discoveries), do: Enum.count(discoveries, &match?(%DiscoveryRecord{}, &1))
end
