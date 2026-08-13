defmodule WebbyWeb.StatusController do
  use WebbyWeb, :controller

  def show(conn, _params) do
    provider = Application.get_env(:webby, :runtime_status_module, Webby.RuntimeStatus)

    case provider.snapshot() do
      {:ok, snapshot} ->
        conn |> put_status(:ok) |> render(:show, snapshot: snapshot)

      {:error, snapshot} ->
        conn |> put_status(:service_unavailable) |> render(:show, snapshot: snapshot)
    end
  end
end
