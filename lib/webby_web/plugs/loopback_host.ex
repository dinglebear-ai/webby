defmodule WebbyWeb.Plugs.LoopbackHost do
  @moduledoc false

  import Plug.Conn

  @allowed_hosts ["127.0.0.1", "localhost", "[::1]"]

  def init(opts), do: opts

  def call(conn, _opts) do
    allowed_hosts = Application.get_env(:webby, :allowed_hosts, @allowed_hosts)

    if conn.host in allowed_hosts do
      conn
    else
      conn |> send_resp(:forbidden, "forbidden host") |> halt()
    end
  end
end
