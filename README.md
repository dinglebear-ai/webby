# Webby

Webby is a standalone local bridge from browser-native WebMCP tools to any
standards-compatible MCP client. It is a Phoenix/Elixir application designed to
run continuously as a per-user background service.

The current implementation provides a loopback-only Phoenix service, SQLite WAL
persistence, atomic runtime discovery metadata, a JSON health endpoint, a local
LiveView dashboard, and durable browser-extension pairing over a versioned
Phoenix Channel protocol with single-use Ed25519 authentication challenges.
The unpacked Manifest V3 extension now scans already-permitted sites by default,
offers explicit broad all-tabs scanning with continuous disclosure, and records
sanitized WebMCP catalogs in the local discovery inbox. Discoveries can be
explicitly promoted into durable page registrations, which bind matching open
documents to live catalog sessions. The authenticated Streamable HTTP endpoint
at `/mcp` exposes one stable, read-only `webby` broker tool for inspecting
status, browsers, discoveries, registered pages, sessions, and current catalogs.
Page tool invocation remains disabled until the next delivery slice.

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
npm test --prefix extension
```

For extension development, load the [`extension`](extension) directory as an
unpacked Chrome extension, open its popup, set the loopback Webby URL if needed,
and submit a pairing request for approval in the local dashboard.

Build a production release:

```bash
MIX_ENV=prod mise exec -- mix assets.deploy
MIX_ENV=prod mise exec -- mix release
```

Production startup binds exclusively to `127.0.0.1:6477` unless `WEBBY_PORT`
selects a different loopback port. On first launch, Webby creates a stable,
owner-only signing secret under its platform configuration directory;
`SECRET_KEY_BASE` can override it for managed deployments.

## Design

- [Architecture specification](docs/superpowers/specs/2026-08-13-webby-design.md)
- [Foundation implementation plan](docs/superpowers/plans/2026-08-13-webby-foundation.md)
- [Browser pairing implementation plan](.claude/plans/browser-pairing/plan.md)
- [Extension discovery implementation plan](.claude/plans/extension-discovery/plan.md)
