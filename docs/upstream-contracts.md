# Upstream contracts

Webby is a bridge, so most of its correctness is defined elsewhere. Section 21
of the [design spec](superpowers/specs/2026-08-13-webby-design.md) requires the
external contracts to be "pinned and recorded". This is that mechanism.

## What is tracked

`priv/contracts/upstream.lock.json` records the observed state of each upstream
document. Every entry carries a `why` and the `webby_surfaces` it governs, so a
drift report says what to go re-read rather than just that a hash changed.

| Contract | Source | Why it matters to Webby |
|---|---|---|
| `webmcp-spec` | `webmachinelearning/webmcp` → `index.bs` | Defines `Document.modelContext`, `getTools(options)`, and the `RegisteredTool` / `ToolAnnotations` dictionaries the extension probe reads |
| `webmcp-implementation-status` | same repo → `implementation-status.md` | Per-browser rollout. Webby feature-detects, so what browsers ship bounds what it can reach |
| `webmcp-declarative-explainer` | same repo → `declarative-api-explainer.md` | A proposed authoring surface Webby does not implement yet |
| `webmcp-types` | npm `webmcp-types` | Published type definitions; the cheapest signal that the tool descriptor shape moved |
| `mcp-spec` | `modelcontextprotocol/modelcontextprotocol` tags | Protocol revisions Webby advertises in `Webby.MCP.Protocol` |

The WebMCP spec has no releases or tags — it is a living Bikeshed document — so
it is tracked by content hash. The MCP spec publishes dated tags, so it is
tracked by tag, which also lets the checker answer a sharper question than
"did anything change".

## Two kinds of finding

**Drift** is informational. An upstream document changed; someone should read
the diff and decide whether Webby needs to follow. Nothing is broken yet.

**Protocol misalignment** is a real defect, and the checker reports it
separately:

- Webby advertises a `latest` MCP revision that upstream has superseded.
- Webby claims support for a revision upstream never published.

## Running it

```bash
mix webby.contracts.check
```

`--format markdown` produces the report CI posts. `--exit-code` makes drift
non-zero, off by default so the scheduled run reports without going red. An
unreachable upstream always exits 2 — an unknown is never reported as clean.

## Adopting an upstream change

1. Read the actual diff. The report links the upstream compare view.
2. Check the `webby_surfaces` listed for that contract.
3. Make whatever code change it warrants — or none, deliberately.
4. Re-pin and commit the lock in the same PR:

```bash
mix webby.contracts.check --update
```

Re-pinning without step 1 turns the check into a rubber stamp. `--update`
refuses to run when any contract was unreachable, so a network blip cannot
silently pin a value that was never observed.

## Automation

`.github/workflows/upstream-contracts.yml` runs the check every Monday and on
demand. Drift is collected into a single rolling issue labelled
`upstream-drift` — subsequent runs comment on it rather than opening new ones.
The schedule only fails when an upstream is unreachable, because a red build
should mean something is wrong with Webby.

## Known gaps

- Content hashing detects *that* the WebMCP spec moved, not *what* moved.
  Reading the linked commit range is a manual step.
- `webmcp-types` is tracked but not yet consumed. Type-checking
  `extension/src/probe.js` against it would turn a descriptor-shape change from
  a notification into a test failure — the obvious next step.
- Chrome and Edge origin-trial expiry is only visible through
  `implementation-status.md`; there is no direct Chrome Status check.
