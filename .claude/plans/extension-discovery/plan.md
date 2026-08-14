# Extension discovery slice

## Outcome

Ship a Labby-independent Manifest V3 Chrome extension and Phoenix discovery inbox. The extension scans eligible already-permitted tabs by default, supports an explicit broad all-tabs permission mode, and sends only sanitized WebMCP catalog observations to an authenticated Webby browser channel. Unregistered tools remain non-callable.

## Checkpoints

1. Add durable discovery storage, canonical URL/catalog sanitization, fingerprinting, and deduplicating upsert tests.
2. Extend Browser Protocol v1 and the authenticated channel with bounded discovery observations and full-resync acknowledgements.
3. Add the discovery inbox and persistent scanning disclosure to the local LiveView.
4. Add the MV3 extension with local identity/pairing, granted-sites scanning, explicit all-tabs permission request, pause/revoke controls, feature-detected WebMCP catalog probing, and reconnect/resync.
5. Add Elixir and extension contract tests, run full verification, perform focused review, fix every surfaced issue, and open the slice PR.

## Non-goals

- MCP transport or tool advertisement.
- Page tool invocation.
- Page registration and document-session routing.
- Native messaging or any Labby dependency.

## External contracts

- Chrome MV3 tabs, scripting, content-script execution worlds, and optional host permissions.
- Phoenix Channels wire protocol.
- Live WebMCP API feature detection; absence or an unrecognized API is reported as unsupported and never emulated.
