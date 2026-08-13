# Webby Design Specification

**Status:** Proposed for user review  
**Date:** 2026-08-13  
**Product:** Webby  
**Repository:** `dinglebear-ai/webby`  
**Local checkout:** `/home/jmagar/workspace/webby`

## 1. Summary

Webby is a standalone, locally installed Phoenix/Elixir application that turns
WebMCP tools exposed by pages in a user's existing browser into a standard MCP
server. Any compatible MCP client can connect to Webby. Webby does not depend on
Labby, call Labby APIs, share Labby configuration, or require a Labby runtime.

Webby consists of an always-running local Phoenix service, a Manifest V3 browser
extension, a local LiveView management interface, SQLite persistence, a
Streamable HTTP MCP endpoint, and a thin stdio adapter for clients that cannot
use HTTP MCP. The extension discovers WebMCP-capable pages and invokes their
tools in the authenticated browser session the user is already using.

Webby exposes a single stable MCP broker tool by default. Page tools remain
behind actions such as `page.list`, `page.tools`, and `page.call`, avoiding
top-level name collisions and catalog churn. An opt-in direct-tools mode may
project active page tools into the MCP catalog for compatibility.

## 2. Goals

1. Let any MCP client discover and invoke WebMCP tools from the user's current
   Chrome or Chromium-family browser sessions.
2. Remain completely independent of any MCP gateway or specific AI client.
3. Require explicit page registration before tools become callable through MCP.
4. Automatically record WebMCP-capable pages that are encountered but not yet
   registered, without exposing or invoking them.
5. Support automatic scanning of already-permitted sites by default and an
   explicit all-tabs scanning mode with broad browser permission.
6. Preserve correct tab and document identity across navigation, reload,
   extension suspension, browser restart, and duplicate matching tabs.
7. Keep browser data and discovery history local by default.
8. Provide an observable, recoverable local service with a clear security model.

## 3. Non-goals for Version 1

- General-purpose DOM automation, screenshots, arbitrary JavaScript execution,
  or accessibility-tree control.
- Headless browser lifecycle or browser-profile management.
- Cloud synchronization, hosted accounts, telemetry, or remote access.
- A WebMCP polyfill for pages that do not expose WebMCP tools.
- Automatically invoking discovered tools or automatically registering pages.
- Firefox or Safari support. The internal browser protocol remains portable so
  those clients can be added later without changing the MCP contract.
- Labby-specific routing, authentication, UI, metadata, or deployment support.

## 4. Product Identity and Packaging

| Surface | Identity |
|---|---|
| Product | Webby |
| Repository | `dinglebear-ai/webby` |
| Elixir OTP application | `webby` |
| Root Elixir module | `Webby` |
| MCP server name | `webby` |
| Browser extension package | `@dinglebear-ai/webby-extension` |
| Browser protocol | Webby Browser Protocol |
| Default loopback port | `6477` |

The repository is a single product monorepo. The Phoenix application owns the
runtime, database, UI, MCP endpoint, and installation commands. The extension is
built from a dedicated top-level directory but released with the same product.

## 5. System Architecture

```text
WebMCP-enabled document
        ^
        | browser-mediated discovery and invocation
        v
Webby browser extension
        ^
        | signed, versioned WebSocket messages
        v
Phoenix Channels -- Webby Browser Protocol
        |
        v
Webby runtime -- Ecto/SQLite -- LiveView UI
        |
        +-- Streamable HTTP MCP at /mcp
        |
        +-- local HTTP API used only by Webby-owned surfaces
        |
        +-- thin stdio adapter for stdio-only MCP clients
```

### 5.1 Always-running local service

Webby is installed as a per-user background service:

- Linux: systemd user service.
- macOS: LaunchAgent.
- Windows: per-user Windows service or equivalent login-started service whose
  lifecycle is managed by the Webby installer.

The service binds only to `127.0.0.1` by default, starts at login, restarts after
unexpected failure, and does not silently bind to a non-loopback interface.
Failure to bind the configured port is fatal and visible in service logs.

### 5.2 Phoenix application

Phoenix owns:

- the loopback HTTP listener;
- Phoenix Channels for browser connections;
- the LiveView operator UI;
- MCP Streamable HTTP transport;
- browser, page, discovery, session, and credential state;
- catalog normalization and routing;
- invocation auditing and structured errors.

### 5.3 Browser extension

The Manifest V3 extension owns:

- browser permission requests and current grants;
- tab enumeration and lifecycle events;
- document-local WebMCP discovery;
- catalog snapshots and catalog-change reporting;
- invocation of the selected document's WebMCP tool;
- a persistent extension identity keypair;
- resilient connection and resynchronization with Webby.

The extension does not implement MCP, expose a network listener, persist the
authoritative page registry, or communicate with remote services.

### 5.4 No native messaging helper in version 1

The extension connects directly to the loopback Phoenix Channel endpoint. A
native messaging helper is intentionally excluded because the always-running
service already supplies lifecycle, discovery, and IPC. It may be introduced in
a later version only if a verified browser-platform restriction requires it.

### 5.5 stdio adapter

`webby mcp-stdio` is a thin transport adapter. It translates stdio MCP messages
to the local Webby runtime and returns runtime responses. It owns no database,
browser connection, page registry, or tool execution logic. Starting the stdio
adapter never starts a second authoritative Webby server.

## 6. Core Domain Model

### 6.1 Browser

A paired extension installation/profile.

```text
Browser
  id
  display_name
  extension_id
  public_key
  paired_at
  last_seen_at
  revoked_at
```

`Browser` is durable. A browser connection is not.

### 6.2 PageRegistration

A durable user-approved rule that makes matching page tools eligible for MCP.

```text
PageRegistration
  id
  slug
  display_name
  origin
  url_pattern
  preferred_browser_id optional
  auto_attach
  enabled
  exposure_mode broker | direct
  created_at
  updated_at
```

Registrations match sanitized URLs. Query strings and fragments are excluded
from persisted match rules. A registration can optionally prefer one paired
browser, but the data model is browser-family neutral.

### 6.3 Discovery

A local informational record for an encountered WebMCP page that is not
registered.

```text
Discovery
  id
  origin
  sanitized_path
  page_title
  tool_count
  catalog_fingerprint
  catalog_summary
  first_seen_at
  last_seen_at
  detection_count
  browser_id
  state discovered | ignored | registered
```

The catalog summary contains tool names, descriptions, and schemas. It does not
contain page contents, tool results, form values, cookies, authorization data,
query strings, fragments, or request/response bodies.

### 6.4 DocumentSession

The ephemeral binding to one currently loaded document.

```text
DocumentSession
  id
  browser_id
  tab_id
  document_id
  registration_id optional
  current_origin
  sanitized_url
  page_title
  catalog_revision
  catalog_fingerprint
  connected_at
  last_seen_at
  status
```

Tab IDs are never treated as durable identity. Navigation or reload replaces
the document identity and invalidates calls bound to the previous document.

### 6.5 ToolBinding

```text
ToolBinding
  document_session_id
  catalog_revision
  webmcp_name
  description
  input_schema
  output_schema optional
  annotations
```

A callable tool identity is the tuple:

```text
browser_id + tab_id + document_id + catalog_revision + webmcp_name
```

## 7. Scanning and Discovery

### 7.1 Granted-sites mode

Granted-sites mode is the default. Webby automatically scans every open tab for
which the extension already has site access. Webby never requests broader host
permission merely to populate discovery history.

### 7.2 All-tabs mode

All-tabs mode is an explicit opt-in setting. Enabling it requests the browser's
broad host permission and scans every eligible open tab automatically. The
extension UI and Webby UI continuously display that broad scanning is enabled.
The user can pause scanning or return to granted-sites mode at any time.

### 7.3 Exclusions

Both modes exclude:

- browser-internal and extension URLs;
- pages the browser forbids extensions from inspecting;
- incognito sessions unless separately authorized by browser settings;
- ignored origins;
- enterprise-restricted pages;
- frames that are not permitted to expose WebMCP tools.

### 7.4 Discovery behavior

When the extension encounters WebMCP tools:

1. It sanitizes the page identity.
2. It computes a deterministic catalog fingerprint.
3. If a registration matches, it creates or refreshes a document session.
4. Otherwise, it upserts a local discovery record.
5. It never invokes or exposes unregistered tools.

Discoveries deduplicate by origin, sanitized path policy, browser identity, and
catalog fingerprint. Catalog changes update `last_seen_at`, increment detection
count, and create a new fingerprinted observation without losing prior audit
context.

## 8. Registration and Routing

The user promotes a discovery or manually selects a permitted open tab to create
a page registration. Registration requires explicit confirmation in the local
Webby UI or extension UI.

Multiple live documents may match one registration. Webby uses this routing
order:

1. an explicit document/session selector supplied by the caller;
2. the registration's preferred paired browser;
3. the most recently active healthy matching document;
4. otherwise a structured `ambiguous_page_session` or `page_offline` error.

Webby never silently crosses browser profiles when explicit selection is
required to distinguish user accounts or security contexts.

## 9. MCP Surface

### 9.1 Default broker mode

Webby exposes one stable MCP tool named `webby` with an `action` and `params`
request shape.

Initial actions:

| Action | Purpose |
|---|---|
| `page.list` | List registered pages and availability |
| `page.get` | Read one registration and active sessions |
| `page.tools` | List current tools for a registered page/session |
| `page.call` | Invoke one current WebMCP tool |
| `discovery.list` | List unregistered WebMCP discoveries |
| `discovery.get` | Inspect one discovery and its catalog summary |
| `discovery.register` | Promote a discovery into a page registration |
| `discovery.ignore` | Ignore a discovery or origin |
| `browser.list` | List paired browsers and connection state |
| `status` | Report local runtime and browser health |

Mutation actions require the connected MCP client to have administrative scope.
`page.call` requires call scope and is subject to per-page policy.

Example:

```json
{
  "action": "page.call",
  "params": {
    "page": "github",
    "session": "optional-document-session-id",
    "tool": "create_issue",
    "catalog_revision": 7,
    "arguments": {
      "title": "Example"
    }
  }
}
```

### 9.2 Direct-tools compatibility mode

Direct mode is opt-in per registration or MCP client. It projects registered,
currently available WebMCP tools into the MCP tool catalog using collision-safe
names. Webby emits MCP tool-list change notifications when projected tools
appear, disappear, or change schema.

Broker mode remains authoritative. Direct tools route through the same policy,
document identity, revision validation, execution, and audit path as
`page.call`.

### 9.3 Resources and prompts

Version 1 exposes tools only. Page WebMCP tools are not reinterpreted as MCP
resources or prompts.

## 10. Webby Browser Protocol

The extension and Phoenix runtime communicate using a versioned JSON envelope
over authenticated Phoenix Channels. The logical protocol is independent of
Phoenix so another transport can carry it later.

```json
{
  "protocol_version": 1,
  "type": "catalog.changed",
  "request_id": null,
  "browser_id": "browser-uuid",
  "sent_at": "2026-08-13T12:00:00Z",
  "payload": {}
}
```

Version 1 message families:

- pairing request, approval result, and rejection;
- signed authentication challenge and response;
- browser hello and full resynchronization snapshot;
- tab/document opened, changed, navigated, and closed;
- catalog snapshot and catalog changed;
- tool call request, result, failure, cancellation, and timeout;
- heartbeat, acknowledgement, and resync request.

Unknown message types return a protocol error. Unsupported protocol versions are
rejected with the supported version range. Reconnection always begins with a
full extension snapshot so missed browser events cannot leave authoritative
state inconsistent.

## 11. Security and Privacy

### 11.1 Network boundary

- Webby binds only to loopback by default.
- Streamable HTTP validates `Origin` when present.
- Browser WebSocket connections allow only paired extension origins.
- No wildcard CORS policy is permitted.
- Remote listening is not a hidden configuration toggle in version 1.

### 11.2 Browser pairing

The extension generates an identity keypair on first run and stores the private
material only in extension-local storage. Initial pairing creates a
short-lived request visible in the Webby UI. The user confirms the extension ID,
browser/profile display name, and requested scanning mode.

Webby stores only the public key. Subsequent connections authenticate a fresh,
bounded-lifetime challenge signed by the extension. Challenges are single-use,
bound to the Webby instance ID, and rejected after expiration.

Revoking a browser immediately terminates its channels and prevents subsequent
authentication with that key.

### 11.3 MCP client credentials

Webby generates separate MCP client credentials with explicit scopes:

- `read`: status, browsers, registrations, discoveries, and catalogs;
- `call`: invoke tools on registered pages;
- `admin`: register/ignore pages, change scanning policy, pair/revoke clients.

Credentials are displayed once, stored hashed by Webby, and independently
revocable. The stdio adapter reads a per-user credential from a permissions-
restricted configuration file and never prints it.

### 11.4 Page trust

WebMCP tool descriptions, schemas, names, annotations, and results are untrusted
page-controlled data. Webby:

- binds every tool to its origin and immutable document identity;
- applies size and nesting limits before persistence or MCP projection;
- never interprets page-provided strings as HTML in the LiveView UI;
- never treats annotations as sufficient authorization for a call;
- records the origin, tool identity, client identity, and outcome for calls;
- invalidates calls when the document or catalog revision is stale.

### 11.5 Local data minimization

Webby does not persist cookies, authorization headers, page bodies, form values,
query strings, URL fragments, or tool results by default. Invocation audit
records contain metadata and outcome, not arbitrary arguments or response bodies.
No telemetry or discovery data leaves the machine.

## 12. Persistence and Filesystem Layout

Webby uses Ecto with SQLite in WAL mode. The database is the authoritative store
for registrations, discoveries, paired browsers, credential hashes, settings,
and audit metadata. Live document sessions and pending calls are ephemeral and
reconstructed from extension resynchronization.

Platform-specific directories follow OS conventions. On Linux the reference
layout is:

```text
~/.config/webby/config.toml
~/.config/webby/runtime.json
~/.local/share/webby/webby.db
~/.local/state/webby/log/
```

`runtime.json` is written atomically with owner-only permissions and contains:

```json
{
  "instance_id": "uuid",
  "base_url": "http://127.0.0.1:6477",
  "mcp_url": "http://127.0.0.1:6477/mcp",
  "pid": 1234
}
```

It contains no bearer credentials.

## 13. Error Contract

All broker failures use a stable structured envelope:

```json
{
  "kind": "stale_catalog",
  "message": "The page catalog changed before the tool could be invoked.",
  "retryable": true,
  "guidance": "Call page.tools and retry using the new catalog revision.",
  "details": {}
}
```

Initial stable kinds include:

- `invalid_request`
- `unknown_action`
- `unauthorized`
- `forbidden`
- `browser_offline`
- `page_offline`
- `ambiguous_page_session`
- `stale_document`
- `stale_catalog`
- `tool_not_found`
- `tool_input_invalid`
- `tool_timeout`
- `tool_cancelled`
- `page_tool_error`
- `protocol_mismatch`
- `payload_too_large`
- `internal_error`

Transport failures remain distinguishable from completed page tool errors.
Retries are permitted only when the error contract marks them retryable.

## 14. Timeouts, Cancellation, and Backpressure

- Every tool call has a bounded server timeout.
- MCP cancellation propagates through Webby Browser Protocol to the extension.
- Navigation, document replacement, browser disconnect, or catalog replacement
  cancels affected pending calls.
- Each browser and document has bounded concurrent calls and a bounded queue.
- Catalogs, schemas, arguments, and results have explicit byte, depth, and item
  limits at both extension and server boundaries.
- Reconnection does not automatically replay calls whose execution status is
  unknown. Such calls complete with a side-effect-unknown transport error.

## 15. LiveView Management UI

The local UI provides:

- service and MCP endpoint status;
- paired browsers and revoke controls;
- scanning mode, pause control, and persistent all-tabs warning;
- registered pages with live/offline state and session selection;
- discovery inbox with review, register, and ignore actions;
- tool catalog inspection;
- MCP client credential creation and revocation;
- redacted invocation audit and structured error visibility.

The UI does not render arbitrary page HTML. Descriptions and schemas are shown as
escaped text or structured JSON.

## 16. Observability

Webby emits structured logs for:

- service startup and shutdown;
- browser pairing, authentication, connection, and revocation;
- scan and discovery summaries without sensitive URLs;
- registration changes;
- MCP initialization and action dispatch;
- page call start, finish, cancellation, timeout, and routing failure;
- database and protocol errors.

Logs carry correlation IDs across MCP request, server dispatch, browser protocol
request, and extension result. Secrets and page-controlled payload bodies are
redacted. The UI exposes a bounded local audit view; log files remain the full
operator evidence source.

## 17. Installation and Updates

The Webby release installs the Phoenix application, service definition, CLI and
stdio adapter. The browser extension is distributed separately through the
Chrome Web Store and as a development bundle from releases.

First-run flow:

1. Install and start the local Webby service.
2. Open the local Webby UI.
3. Install the browser extension.
4. Pair the extension and approve its scanning mode.
5. Create an MCP client credential.
6. Add Webby's Streamable HTTP endpoint or stdio adapter to any MCP client.
7. Review discovered pages and explicitly register desired pages.

Updates preserve the database, run migrations before accepting traffic, and
fail without replacing the last working release when migration or health checks
fail.

## 18. Testing Strategy

### 18.1 Elixir tests

- Ecto constraints and state transitions.
- URL sanitization and page matching.
- discovery deduplication and catalog fingerprinting.
- routing with zero, one, and multiple matching sessions.
- immutable document/catalog revision enforcement.
- credential scopes, pairing challenges, revocation, and replay rejection.
- MCP broker actions and structured error mapping.
- Channel reconnect and full-resynchronization behavior.
- size limits, cancellation, timeout, and queue behavior.

### 18.2 Extension tests

- permission-mode transitions.
- eligible and excluded tab scanning.
- WebMCP catalog discovery and tool invocation.
- navigation and document replacement.
- service-worker termination and reconnect.
- signed challenge authentication.
- sanitization before data leaves the extension.

### 18.3 Contract tests

Shared fixtures validate every Webby Browser Protocol message in both TypeScript
and Elixir. MCP transport tests cover initialization, tools listing, calls,
notifications, cancellation, authentication, and invalid sessions against the
supported MCP specification version.

### 18.4 End-to-end tests

A deterministic test page registers WebMCP tools, changes its catalog, navigates,
returns errors, and runs cancellable calls. Browser tests prove:

1. an unregistered page appears only in discovery;
2. registration makes it available through broker mode;
3. an MCP client invokes it through the real extension and page;
4. navigation invalidates the old call identity;
5. ignored origins disappear from scanning;
6. all-tabs mode and granted-sites mode obey their permission contracts;
7. Webby survives extension service-worker and Phoenix service restarts.

### 18.5 Security tests

- origin and loopback enforcement;
- WebSocket authentication and challenge replay;
- schema/result size and nesting bombs;
- malicious names, descriptions, and HTML payloads;
- cross-profile routing isolation;
- stale-document substitution;
- unauthorized discovery mutation and tool invocation;
- secret and sensitive-URL absence from logs and database.

## 19. Acceptance Criteria

Webby version 1 is complete when all of the following are demonstrated:

1. A clean machine can install Webby as an automatically started local service.
2. The local UI can pair and revoke a Chrome/Chromium extension.
3. Granted-sites mode scans only already-permitted eligible tabs.
4. All-tabs mode requires explicit broad permission and displays persistent
   disclosure while enabled.
5. An unregistered WebMCP page is recorded locally but cannot be invoked by MCP.
6. A user can promote that discovery into an explicit registration.
7. An arbitrary standards-compatible MCP client can connect without Labby and
   invoke the registered page through `webby` / `page.call`.
8. A stdio-only client can perform the same call through the thin adapter.
9. Reload or navigation makes the old document/catalog identity uncallable.
10. Multiple matching tabs are routed deterministically or return an explicit
    ambiguity error.
11. Browser and service restarts restore durable configuration and resynchronize
    current tabs without persisting ephemeral tab IDs as registrations.
12. No test or runtime path requires a Labby process, API, credential, package,
    configuration file, or network endpoint.

## 20. Delivery Boundaries

Implementation should proceed in independently verifiable vertical slices:

1. Phoenix foundation, persistence, service runtime, and local status UI.
2. Browser pairing and versioned Channel protocol.
3. Extension scanning and discovery inbox.
4. Page registration, document sessions, and catalog lifecycle.
5. MCP broker transport and read-only actions.
6. End-to-end `page.call`, cancellation, and error contract.
7. stdio adapter and client configuration workflow.
8. Direct-tools compatibility mode.
9. installers, packaging, upgrade safety, and cross-platform verification.

Each slice must include its tests and observable runtime evidence. Direct-tools
mode cannot delay or weaken completion of the default broker path.

## 21. Authoritative External Contracts

Implementation must follow the then-current official specifications and browser
documentation, pinned and recorded in the implementation plan:

- Model Context Protocol lifecycle, tools, authorization, and Streamable HTTP
  transport specifications.
- WebMCP `document.modelContext` registration, discovery, invocation, lifecycle,
  permissions policy, and cancellation behavior.
- Chrome Manifest V3 extension, service-worker lifecycle, tabs, scripting,
  permissions, and Web Store policies.
- Phoenix Channels, LiveView, Releases, and platform service integration.

Where WebMCP browser APIs remain experimental or differ across Chrome versions,
Webby must feature-detect the live API and report unsupported capability rather
than simulating tools or silently falling back to general browser automation.
