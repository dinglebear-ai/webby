import Config

world_root = System.fetch_env!("WEBBY_E2E_WORLD_ROOT") |> Path.expand()
database = System.fetch_env!("WEBBY_DATABASE_PATH") |> Path.expand()
runtime_file = System.fetch_env!("WEBBY_E2E_RUNTIME_FILE") |> Path.expand()
port = 0
authority_port = System.fetch_env!("WEBBY_AUTHORITY_PORT") |> String.to_integer()
instance_nonce = System.fetch_env!("WEBBY_E2E_INSTANCE_NONCE")

unless System.get_env("WEBBY_ENVIRONMENT_MARKER") == "isolated-e2e" do
  raise "WEBBY_ENVIRONMENT_MARKER must identify an isolated E2E world"
end

unless String.starts_with?(database, world_root <> "/") and
         String.starts_with?(runtime_file, world_root <> "/") do
  raise "E2E database and runtime paths must remain inside WEBBY_E2E_WORLD_ROOT"
end

for unsafe <- [Path.expand("../webby_dev.db", __DIR__), Path.expand("../webby_test.db", __DIR__)] do
  if database == unsafe, do: raise("refusing developer or test database path")
end

config :webby, Webby.Repo,
  database: database,
  journal_mode: :wal,
  foreign_keys: :on,
  busy_timeout: 5_000,
  pool_size: 5

config :webby,
  allowed_hosts: ["127.0.0.1", "localhost", "[::1]"],
  authority_port: authority_port,
  instance_id_provider: fn -> instance_nonce end,
  listen_host: {127, 0, 0, 1},
  listen_port: port,
  runtime_discovery: true,
  retention_enabled: false

config :webby, WebbyWeb.Endpoint,
  url: [host: "127.0.0.1", port: port, scheme: "http"],
  http: [ip: {127, 0, 0, 1}, port: port],
  secret_key_base: System.fetch_env!("SECRET_KEY_BASE"),
  server: true

config :webby, Webby.RuntimeDiscovery,
  path: runtime_file,
  metadata: fn ->
    actual_port =
      System.fetch_env!("WEBBY_E2E_BOUND_PORT_FILE")
      |> File.read!()
      |> String.trim()
      |> String.to_integer()

    base_url = "http://127.0.0.1:#{actual_port}"

    %{
      schema_version: 1,
      product_version: Application.spec(:webby, :vsn) |> to_string(),
      instance_id: instance_nonce,
      environment_marker: "isolated-e2e",
      base_url: base_url,
      capabilities: %{
        health: %{
          status: "available",
          url: base_url <> "/health",
          transport: "http-json",
          instance_nonce: instance_nonce,
          environment_marker: "isolated-e2e"
        },
        mcp: %{
          status: "available",
          url: base_url <> "/mcp",
          transport: "streamable-http",
          protocol_versions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"]
        }
      },
      pid: System.pid()
    }
  end

config :webby, Webby.Mailer, adapter: Swoosh.Adapters.Test
config :swoosh, :api_client, false
config :logger, level: :info
config :phoenix, :plug_init_mode, :runtime
