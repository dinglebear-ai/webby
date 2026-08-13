defmodule Webby.Repo do
  use Ecto.Repo,
    otp_app: :webby,
    adapter: Ecto.Adapters.SQLite3
end
