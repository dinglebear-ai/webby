# Webby

Webby is a standalone local bridge from browser-native WebMCP tools to any
standards-compatible MCP client. It is a Phoenix/Elixir application designed to
run continuously as a per-user background service.

The current foundation provides a loopback-only Phoenix service, SQLite WAL
persistence, atomic runtime discovery metadata, a JSON health endpoint, and a
local LiveView dashboard. Browser-extension pairing and MCP transport arrive in
subsequent delivery slices.

Webby is independent software. It has no dependency on Labby or any other MCP
gateway, and no particular MCP client receives privileged integration.

## Development

```bash
mise install
mise exec -- mix setup
mise exec -- mix phx.server
```

The local dashboard is available at <http://127.0.0.1:6477/> and health can be
checked with:

```bash
curl --fail http://127.0.0.1:6477/health
```

Run the verification suite:

```bash
MIX_ENV=test mise exec -- mix test
MIX_ENV=test mise exec -- mix credo --strict
```

Build a production release:

```bash
MIX_ENV=prod mise exec -- mix assets.deploy
MIX_ENV=prod mise exec -- mix release
```

Production startup requires `SECRET_KEY_BASE` and binds exclusively to
`127.0.0.1:6477` unless `WEBBY_PORT` selects a different loopback port.

## Design

- [Architecture specification](docs/superpowers/specs/2026-08-13-webby-design.md)
- [Foundation implementation plan](docs/superpowers/plans/2026-08-13-webby-foundation.md)
