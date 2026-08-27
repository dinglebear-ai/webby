defmodule WebbyWeb.BrowserOrigin do
  @moduledoc false

  @process_key {__MODULE__, :extension_id}

  def allowed?(%URI{scheme: "chrome-extension", host: extension_id}) do
    if is_binary(extension_id) and String.match?(extension_id, ~r/\A[a-p]{32}\z/) do
      # Phoenix's origin-check callback receives the parsed Origin but not the
      # connection. The socket connect callback runs synchronously in this same
      # request process, so retain the browser-authenticated identity just long
      # enough to bind it to the query parameter there.
      Process.put(@process_key, extension_id)
      true
    else
      false
    end
  end

  def allowed?(_uri), do: false

  def take_extension_id, do: Process.delete(@process_key)
end
