import Config

# Configure your database
#
# The MIX_TEST_PARTITION environment variable can be used
# to provide built-in test partitioning in CI environment.
# Run `mix help test` for more information.
config :webby, Webby.Repo,
  database: Path.expand("../webby_test#{System.get_env("MIX_TEST_PARTITION")}.db", __DIR__),
  journal_mode: :wal,
  foreign_keys: :on,
  busy_timeout: 5_000,
  pool_size: 5,
  pool: Ecto.Adapters.SQL.Sandbox

config :webby,
  allowed_hosts: ["www.example.com", "127.0.0.1", "localhost", "[::1]"],
  instance_id_provider: fn -> "test-instance-id" end,
  runtime_discovery: false,
  runtime_status_module: Webby.TestHealthyRuntimeStatus

# We don't run a server during test. If one is required,
# you can enable the server option below.
config :webby, WebbyWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: "I+ddbSslsdXjx+TvmZNA+5s2EHbhtPG9whKIpn+V/vVx6RLKPqtnKWjdKWXPG/fc",
  server: false

# In test we don't send emails
config :webby, Webby.Mailer, adapter: Swoosh.Adapters.Test

# Disable swoosh api client as it is only required for production adapters
config :swoosh, :api_client, false

# Print only warnings and errors during test
config :logger, level: :warning

# Initialize plugs at runtime for faster test compilation
config :phoenix, :plug_init_mode, :runtime

# Enable helpful, but potentially expensive runtime checks
config :phoenix_live_view,
  enable_expensive_runtime_checks: true

# Sort query params output of verified routes for robust url comparisons
config :phoenix,
  sort_verified_routes_query_params: true
