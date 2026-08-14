defmodule WebbyWeb.DashboardLive do
  use WebbyWeb, :live_view

  alias Webby.MCP.Credentials

  @refresh_interval :timer.seconds(5)

  @impl true
  def mount(_params, _session, socket) do
    if connected?(socket), do: Process.send_after(self(), :refresh_status, @refresh_interval)

    {:ok,
     socket
     |> assign(:credential_token, nil)
     |> assign_credentials()
     |> assign_status()
     |> assign_browsers()
     |> assign_discoveries()
     |> assign_pages()}
  end

  @impl true
  def handle_info(:refresh_status, socket) do
    Process.send_after(self(), :refresh_status, @refresh_interval)

    {:noreply,
     socket |> assign_status() |> assign_browsers() |> assign_discoveries() |> assign_pages()}
  end

  @impl true
  def handle_event("approve-pairing", %{"id" => id}, socket),
    do: {:noreply, resolve(socket, Webby.Browsers.approve_pairing(id), "Browser paired")}

  def handle_event("reject-pairing", %{"id" => id}, socket),
    do: {:noreply, resolve(socket, Webby.Browsers.reject_pairing(id), "Pairing rejected")}

  def handle_event("revoke-browser", %{"id" => id}, socket),
    do: {:noreply, resolve(socket, Webby.Browsers.revoke_browser(id), "Browser revoked")}

  def handle_event("ignore-discovery", %{"id" => id}, socket),
    do: {:noreply, resolve_discovery(socket, Webby.Discovery.ignore(id), "Discovery ignored")}

  def handle_event("register-discovery", %{"id" => id}, socket),
    do:
      {:noreply,
       resolve_page(socket, Webby.Pages.register_discovery(id), "Page registration created")}

  def handle_event("create-mcp-credential", _params, socket) do
    case Credentials.create("Local MCP client") do
      {:ok, _credential, token} ->
        {:noreply, socket |> assign(:credential_token, token) |> assign_credentials()}

      {:error, _reason} ->
        {:noreply, put_flash(socket, :error, "The MCP credential could not be created")}
    end
  end

  def handle_event("revoke-mcp-credential", %{"id" => id}, socket) do
    case Credentials.revoke(id) do
      {:ok, _credential} ->
        {:noreply,
         socket
         |> assign(:credential_token, nil)
         |> put_flash(:info, "MCP credential revoked")
         |> assign_credentials()}

      {:error, _reason} ->
        {:noreply, put_flash(socket, :error, "The MCP credential could not be revoked")}
    end
  end

  @impl true
  def render(assigns) do
    ~H"""
    <Layouts.app flash={@flash}>
      <section class="space-y-8" data-status={@snapshot.status}>
        <header class="space-y-2">
          <p class="text-sm font-semibold uppercase tracking-[0.2em] text-cyan-600">Local service</p>
          <h1 class="text-4xl font-semibold tracking-tight">Webby</h1>
          <p class="text-base text-base-content/70">
            Your independent bridge from browser-native WebMCP tools to any MCP client.
          </p>
        </header>

        <div class="grid gap-4 sm:grid-cols-2">
          <article class="rounded-2xl border border-base-300 bg-base-100 p-6 shadow-sm">
            <p class="text-sm text-base-content/60">Service</p>
            <p class="mt-2 text-xl font-medium">{@snapshot.status}</p>
            <p class="mt-1 font-mono text-sm">{@snapshot.runtime.base_url}</p>
          </article>
          <article class="rounded-2xl border border-base-300 bg-base-100 p-6 shadow-sm">
            <p class="text-sm text-base-content/60">SQLite</p>
            <p class="mt-2 text-xl font-medium">{@snapshot.database.status}</p>
            <p :if={@snapshot.database[:journal_mode]} class="mt-1 text-sm">
              Journal mode: {@snapshot.database.journal_mode}
            </p>
          </article>
        </div>

        <p class="rounded-xl bg-base-200 px-4 py-3 text-sm text-base-content/70">
          Extension discovery and explicit page registration are active. Only registered pages can create live tool sessions.
        </p>

        <section class="space-y-3" id="mcp-access">
          <h2 class="text-2xl font-semibold">MCP access</h2>
          <p class="text-sm text-base-content/60">
            Create a read-only bearer credential for any standards-compatible MCP client.
          </p>
          <button
            phx-click="create-mcp-credential"
            class="rounded-lg bg-cyan-700 px-3 py-2 text-sm font-medium text-white"
          >Create read credential</button>
          <div
            :if={@credential_token}
            id="mcp-credential-token"
            class="rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950"
          >
            <p class="text-sm font-semibold">Copy this token now. It will not be shown again.</p>
            <code class="mt-2 block break-all font-mono text-xs">{@credential_token}</code>
          </div>
          <article
            :for={credential <- @mcp_credentials}
            id={"mcp-credential-#{credential.id}"}
            class="flex items-center justify-between rounded-xl border border-base-300 p-4"
          >
            <div>
              <p class="text-sm font-medium">{credential.display_name}</p>
              <p class="text-xs text-base-content/60">
                {if credential.revoked_at, do: "Revoked", else: "Read access"}
              </p>
            </div>
            <button
              :if={is_nil(credential.revoked_at)}
              phx-click="revoke-mcp-credential"
              phx-value-id={credential.id}
              class="rounded-lg border border-rose-300 px-3 py-2 text-sm font-medium text-rose-700"
            >Revoke</button>
          </article>
        </section>

        <section class="space-y-4" id="browser-pairing">
          <h2 class="text-2xl font-semibold">Pairing requests</h2>
          <p
            :if={@pairings == []}
            class="rounded-xl border border-dashed border-base-300 p-5 text-sm text-base-content/60"
          >
            No extension is waiting for approval.
          </p>
          <article
            :for={pairing <- @pairings}
            id={"pairing-#{pairing.id}"}
            class="flex flex-col gap-4 rounded-2xl border border-amber-300 bg-amber-50 p-5 sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <p class="font-medium text-amber-950">{pairing.display_name}</p><p class="font-mono text-xs text-amber-900/70">
                {pairing.extension_id}
              </p><p class="mt-1 text-xs text-amber-900/70">
                Requested mode: {pairing.scanning_mode}
              </p><p class="mt-1 font-mono text-xs text-amber-900/70">
                Key: {public_key_fingerprint(pairing.public_key)}
              </p>
            </div>
            <div class="flex gap-2">
              <button
                phx-click="reject-pairing"
                phx-value-id={pairing.id}
                class="rounded-lg border border-amber-700 px-3 py-2 text-sm font-medium text-amber-900"
              >Reject</button><button
                phx-click="approve-pairing"
                phx-value-id={pairing.id}
                class="rounded-lg bg-amber-900 px-3 py-2 text-sm font-medium text-white"
              >Approve</button>
            </div>
          </article>
        </section>
        <section class="space-y-4" id="paired-browsers">
          <h2 class="text-2xl font-semibold">Paired browsers</h2>
          <aside
            :if={Enum.any?(@browsers, &(&1.scanning_mode == "all_tabs" and is_nil(&1.revoked_at)))}
            id="all-tabs-disclosure"
            role="alert"
            class="rounded-xl border border-rose-300 bg-rose-50 p-4 text-sm text-rose-950"
          >
            <strong>Broad tab scanning is enabled.</strong>
            At least one paired browser can inspect every eligible permitted tab. Pause scanning, return the extension to granted-sites mode, or revoke that browser to disable this access.
          </aside>
          <p :if={@browsers == []} class="text-sm text-base-content/60">No browsers paired yet.</p>
          <article
            :for={browser <- @browsers}
            id={"browser-#{browser.id}"}
            class="flex items-center justify-between rounded-2xl border border-base-300 p-5"
          >
            <div>
              <p class="font-medium">{browser.display_name}</p><p class="text-xs text-base-content/60">
                {if browser.revoked_at, do: "Revoked", else: "Paired"} · {scanning_mode_label(
                  browser.scanning_mode
                )} · {if browser.scanning_paused, do: "Paused", else: "Scanning"}
              </p>
            </div>
            <button
              :if={is_nil(browser.revoked_at)}
              phx-click="revoke-browser"
              phx-value-id={browser.id}
              class="rounded-lg border border-rose-300 px-3 py-2 text-sm font-medium text-rose-700"
            >Revoke</button>
          </article>
        </section>
        <section class="space-y-4" id="discovery-inbox">
          <div>
            <h2 class="text-2xl font-semibold">Discovery inbox</h2>
            <p class="mt-1 text-sm text-base-content/60">
              Sanitized WebMCP catalogs found on unregistered pages.
            </p>
          </div>
          <p
            :if={@discoveries == []}
            class="rounded-xl border border-dashed border-base-300 p-5 text-sm text-base-content/60"
          >
            No unregistered WebMCP pages discovered yet.
          </p>
          <article
            :for={discovery <- @discoveries}
            id={"discovery-#{discovery.id}"}
            class="rounded-2xl border border-base-300 p-5"
          >
            <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p class="font-medium">{discovery.page_title}</p>
                <p class="font-mono text-xs text-base-content/60">
                  {discovery.origin}{discovery.sanitized_path}
                </p>
              </div>
              <p class="text-sm text-base-content/60">
                {discovery.tool_count} tools · seen {discovery.detection_count} times
              </p>
            </div>
            <ul class="mt-3 flex flex-wrap gap-2" aria-label="Discovered tools">
              <li
                :for={tool <- discovery.catalog_summary["tools"]}
                class="rounded-full bg-base-200 px-3 py-1 font-mono text-xs"
              >
                {tool["name"]}
              </li>
            </ul>
            <div class="mt-4 flex gap-2">
              <button
                phx-click="register-discovery"
                phx-value-id={discovery.id}
                class="rounded-lg bg-cyan-700 px-3 py-2 text-sm font-medium text-white"
              >Register page</button>
              <button
                phx-click="ignore-discovery"
                phx-value-id={discovery.id}
                class="rounded-lg border border-base-300 px-3 py-2 text-sm font-medium"
              >Ignore</button>
            </div>
          </article>
        </section>
        <section class="space-y-4" id="page-registrations">
          <div>
            <h2 class="text-2xl font-semibold">Registered pages</h2>
            <p class="mt-1 text-sm text-base-content/60">
              User-approved pages eligible for the future MCP broker surface.
            </p>
          </div>
          <p :if={@registrations == []} class="text-sm text-base-content/60">
            No pages registered yet.
          </p>
          <article
            :for={registration <- @registrations}
            id={"registration-#{registration.id}"}
            class="rounded-2xl border border-cyan-200 bg-cyan-50/40 p-5"
          >
            <p class="font-medium">{registration.display_name}</p>
            <p class="font-mono text-xs text-base-content/60">
              {registration.origin}{registration.url_pattern}
            </p>
            <p class="mt-2 text-xs text-base-content/60">
              {Enum.count(@sessions, &(&1.registration_id == registration.id))} active sessions · {registration.exposure_mode} mode
            </p>
          </article>
        </section>
      </section>
    </Layouts.app>
    """
  end

  defp assign_status(socket) do
    provider = Application.get_env(:webby, :runtime_status_module, Webby.RuntimeStatus)
    {_result, snapshot} = provider.snapshot()
    assign(socket, :snapshot, snapshot)
  end

  defp assign_browsers(socket),
    do:
      assign(socket,
        browsers: Webby.Browsers.list_browsers(),
        pairings: Webby.Browsers.list_pending_pairings()
      )

  defp assign_discoveries(socket),
    do: assign(socket, :discoveries, Webby.Discovery.list_discoveries())

  defp assign_pages(socket),
    do:
      assign(socket,
        registrations: Webby.Pages.list_registrations(),
        sessions: Webby.Pages.list_active_sessions()
      )

  defp assign_credentials(socket), do: assign(socket, :mcp_credentials, Credentials.list())

  defp resolve(socket, {:ok, _value}, message),
    do: socket |> put_flash(:info, message) |> assign_browsers()

  defp resolve(socket, {:error, _reason}, _message),
    do: put_flash(socket, :error, "The request could not be completed")

  defp resolve_discovery(socket, {:ok, _value}, message),
    do: socket |> put_flash(:info, message) |> assign_discoveries()

  defp resolve_discovery(socket, {:error, _reason}, _message),
    do: put_flash(socket, :error, "The discovery could not be updated")

  defp resolve_page(socket, {:ok, _value}, message),
    do: socket |> put_flash(:info, message) |> assign_discoveries() |> assign_pages()

  defp resolve_page(socket, {:error, _reason}, _message),
    do: put_flash(socket, :error, "The page could not be registered")

  defp scanning_mode_label("all_tabs"), do: "All eligible tabs"
  defp scanning_mode_label("granted_sites"), do: "Granted sites only"

  defp public_key_fingerprint(public_key) do
    digest = :crypto.hash(:sha256, public_key) |> Base.encode16(case: :lower)
    "SHA256:" <> String.slice(digest, 0, 16)
  end
end
