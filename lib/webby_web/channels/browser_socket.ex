defmodule WebbyWeb.BrowserSocket do
  use Phoenix.Socket

  channel "browser:pairing:*", WebbyWeb.BrowserChannel
  channel "browser:auth", WebbyWeb.BrowserChannel

  @impl true
  def connect(%{"extension_id" => extension_id} = params, socket, _connect_info) do
    if valid_extension_id?(extension_id) do
      {:ok, assign(socket, extension_id: extension_id, browser_id: params["browser_id"])}
    else
      :error
    end
  end

  def connect(_params, _socket, _connect_info), do: :error
  @impl true
  def id(%{assigns: %{browser_id: browser_id}}) when is_binary(browser_id),
    do: "browser:#{browser_id}"

  def id(_socket), do: nil

  defp valid_extension_id?(extension_id) when is_binary(extension_id),
    do: String.match?(extension_id, ~r/\A[a-p]{32}\z/)

  defp valid_extension_id?(_extension_id), do: false
end
