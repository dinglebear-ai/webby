defmodule WebbyWeb.DashboardLive do
  use WebbyWeb, :live_view

  @refresh_interval :timer.seconds(5)

  @impl true
  def mount(_params, _session, socket) do
    if connected?(socket), do: Process.send_after(self(), :refresh_status, @refresh_interval)
    {:ok, assign_status(socket)}
  end

  @impl true
  def handle_info(:refresh_status, socket) do
    Process.send_after(self(), :refresh_status, @refresh_interval)
    {:noreply, assign_status(socket)}
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
          MCP transport is not available in this foundation release.
        </p>
      </section>
    </Layouts.app>
    """
  end

  defp assign_status(socket) do
    provider = Application.get_env(:webby, :runtime_status_module, Webby.RuntimeStatus)
    {_result, snapshot} = provider.snapshot()
    assign(socket, :snapshot, snapshot)
  end
end
