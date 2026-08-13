defmodule WebbyWeb.BrowserOrigin do
  @moduledoc false

  def allowed?(%URI{scheme: "chrome-extension", host: extension_id}) do
    is_binary(extension_id) and String.match?(extension_id, ~r/\A[a-p]{32}\z/)
  end

  def allowed?(_uri), do: false
end
