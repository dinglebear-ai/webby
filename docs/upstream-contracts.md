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

Because a hash alone says only *that* something moved, file contracts also pin
the commit they were reviewed at. When drift is found, the report enumerates
the upstream commits since that pin and links the compare view, so the finding
names the actual changes. The commit walk is bounded at 30; a longer gap is
reported as truncated rather than silently cut.

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

## Type-checking the probe

Tracking tells you a specification moved. It does not tell you whether Webby
still matches it — for that, `extension/tsconfig.json` type-checks
`extension/src/probe.js` against the published `webmcp-types` definitions:

```bash
cd extension && npm ci && npm run typecheck
```

This is a contract check, not a build step: nothing is emitted, and only the
files touching the WebMCP surface are included. If upstream renames a field the
probe reads, CI fails with the exact property — rather than the probe silently
reporting an empty catalog on every page, which is how this class of breakage
would otherwise surface.

Both directions are verified: renaming `getTools` or `RegisteredTool.inputSchema`
in the definitions fails the check.

One deliberate exception is documented in the probe itself. The spec has only
ever spelled the field `inputSchema`, but the probe also tolerates a
`input_schema` at runtime in case a browser ships otherwise during origin
trial. That fallback reads through an explicitly loosened view so it cannot
stand in for the specified field — rename `inputSchema` upstream and the check
still fails.

## Where the spec is ahead of Webby

`executeTool()` — the API the invocation path depends on — **is not specified**.
The upstream README still reads *"TODO: Spec and describe the
`modelContext.getTools()` and `modelContext.executeTool()` APIs"*, and
[webmachinelearning/webmcp#51](https://github.com/webmachinelearning/webmcp/issues/51),
which defines how an agent invokes a site's declared tools, has been open since
2025-11-03. `getTools()` was specced in #223; its sibling was not.

Webby feature-detects it and reports `webmcp_unavailable` rather than
simulating invocation, which is what §21 requires. When upstream specs it,
`webmcp-types` will publish a signature and the contract check will report the
version bump — that is the moment to replace the narrow escape hatch in
`invokeWebMcp`.

## A constraint worth knowing before editing the probe

Every exported function in `extension/src/probe.js` is passed as `func:` to
`chrome.scripting.executeScript`, which **serializes the function and loses its
execution context**. A module-scope helper is not defined in the page, so
calling one throws `ReferenceError` — and inside `probeWebMcp`'s `try/catch`
that becomes `supported: false` on every page, i.e. silent total failure of
discovery with a green test suite.

So those functions must be self-contained, and the duplication between them is
forced rather than accidental. `extension/test/injection.test.js` rebuilds each
one from source the way Chrome does and pins the two normalization paths to the
same answer. Do not "clean up" that duplication by extracting a helper.

## Known gaps

- Only `probe.js` is type-checked. Extending the check to the rest of the
  extension needs `@types/chrome` and annotations across `channel.js`,
  `scanning.js`, `permissions.js`, and `service_worker.js` — 112 errors under
  `strict` at last count, so it is a project rather than a follow-up.
- The probe still drops `RegisteredTool.title` and `origin`, and calls
  `getTools()` without `fromOrigins`. None carries a safety signal, unlike
  `annotations`, which is now carried through.
- Chrome and Edge origin-trial expiry is only visible through
  `implementation-status.md`; there is no direct Chrome Status check.
