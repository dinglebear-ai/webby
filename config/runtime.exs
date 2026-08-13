import Config

# config/runtime.exs is executed for all environments, including
# during releases. It is executed after compilation and before the
# system starts, so it is typically used to load production configuration
# and secrets from environment variables or elsewhere. Do not define
# any compile-time configuration in here, as it won't be applied.
# The block below contains prod specific runtime configuration.

# ## Using releases
#
# If you use `mix release`, you need to explicitly enable the server
# by passing the PHX_SERVER=true when you start it:
#
#     PHX_SERVER=true bin/webby start
#
# Alternatively, you can use `mix phx.gen.release` to generate a `bin/server`
# script that automatically sets the env var above.
if System.get_env("PHX_SERVER") do
  config :webby, WebbyWeb.Endpoint, server: true
end

port = String.to_integer(System.get_env("WEBBY_PORT", "6477"))

config :webby,
  listen_host: {127, 0, 0, 1},
  listen_port: port

config :webby, WebbyWeb.Endpoint, http: [ip: {127, 0, 0, 1}, port: port]

if config_env() == :dev do
  # Reload browser tabs when matching files change.
  config :webby, WebbyWeb.Endpoint,
    live_reload: [
      web_console_logger: true,
      patterns: [
        # Static assets, except user uploads
        ~r"priv/static/(?!uploads/).*\.(js|css|png|jpeg|jpg|gif|svg)$"E,
        # Gettext translations
        ~r"priv/gettext/.*\.po$"E,
        # Router, Controllers, LiveViews and LiveComponents
        ~r"lib/webby_web/router\.ex$"E,
        ~r"lib/webby_web/(controllers|live|components)/.*\.(ex|heex)$"E
      ]
    ]
end

if config_env() == :prod do
  config_root =
    System.get_env("XDG_CONFIG_HOME") ||
      Path.join(System.user_home!(), ".config")

  webby_config_dir = Path.join(config_root, "webby")

  database_path =
    System.get_env("WEBBY_DATABASE_PATH") || Path.join(Webby.Paths.data_dir(), "webby.db")

  File.mkdir_p!(Path.dirname(database_path))
  File.chmod!(Path.dirname(database_path), 0o700)

  config :webby, Webby.Repo,
    database: database_path,
    journal_mode: :wal,
    foreign_keys: :on,
    busy_timeout: 5_000,
    pool_size: String.to_integer(System.get_env("POOL_SIZE") || "5")

  # The secret key base is used to sign/encrypt cookies and other secrets.
  # A default value is used in config/dev.exs and config/test.exs but you
  # want to use a different value for prod and you most likely don't want
  # to check this value into version control, so we use an environment
  # variable instead.
  File.mkdir_p!(webby_config_dir)
  File.chmod!(webby_config_dir, 0o700)
  secret_path = Path.join(webby_config_dir, "secret-key-base")

  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      case File.read(secret_path) do
        {:ok, secret} ->
          String.trim(secret)

        {:error, :enoent} ->
          secret = :crypto.strong_rand_bytes(64) |> Base.url_encode64(padding: false)
          temporary = secret_path <> ".tmp.#{System.unique_integer([:positive])}"
          File.write!(temporary, secret <> "\n", [:exclusive])
          File.chmod!(temporary, 0o600)
          File.rename!(temporary, secret_path)
          secret

        {:error, reason} ->
          raise File.Error, reason: reason, action: "read", path: secret_path
      end

  config :webby, :dns_cluster_query, System.get_env("DNS_CLUSTER_QUERY")

  config :webby, WebbyWeb.Endpoint,
    url: [host: "127.0.0.1", port: port, scheme: "http"],
    http: [ip: {127, 0, 0, 1}, port: port],
    secret_key_base: secret_key_base

  # ## SSL Support
  #
  # To get SSL working, you will need to add the `https` key
  # to your endpoint configuration:
  #
  #     config :webby, WebbyWeb.Endpoint,
  #       https: [
  #         ...,
  #         port: 443,
  #         cipher_suite: :strong,
  #         keyfile: System.get_env("SOME_APP_SSL_KEY_PATH"),
  #         certfile: System.get_env("SOME_APP_SSL_CERT_PATH")
  #       ]
  #
  # The `cipher_suite` is set to `:strong` to support only the
  # latest and more secure SSL ciphers. This means old browsers
  # and clients may not be supported. You can set it to
  # `:compatible` for wider support.
  #
  # `:keyfile` and `:certfile` expect an absolute path to the key
  # and cert in disk or a relative path inside priv, for example
  # "priv/ssl/server.key". For all supported SSL configuration
  # options, see https://plug.hexdocs.pm/Plug.SSL.html#configure/1
  #
  # We also recommend setting `force_ssl` in your config/prod.exs,
  # ensuring no data is ever sent via http, always redirecting to https:
  #
  #     config :webby, WebbyWeb.Endpoint,
  #       force_ssl: [hsts: true]
  #
  # Check `Plug.SSL` for all available options in `force_ssl`.

  # ## Configuring the mailer
  #
  # In production you need to configure the mailer to use a different adapter.
  # Here is an example configuration for Mailgun:
  #
  #     config :webby, Webby.Mailer,
  #       adapter: Swoosh.Adapters.Mailgun,
  #       api_key: System.get_env("MAILGUN_API_KEY"),
  #       domain: System.get_env("MAILGUN_DOMAIN")
  #
  # Most non-SMTP adapters require an API client. Swoosh supports Req, Hackney,
  # and Finch out-of-the-box. This configuration is typically done at
  # compile-time in your config/prod.exs:
  #
  #     config :swoosh, :api_client, Swoosh.ApiClient.Req
  #
  # See https://swoosh.hexdocs.pm/Swoosh.html#module-installation for details.
end
