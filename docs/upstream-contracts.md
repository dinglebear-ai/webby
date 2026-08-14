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
| `webmcp-spec` | `webmachinelearning/webmcp` → `index.bs` | Defines `Document.modelContext`, `getTools()`, `executeTool()`, and the `RegisteredTool` / `ToolAnnotations` dictionaries the extension probe reads |
| `webmcp-implementation-status` | same repo → `implementation-status.md` | Per-browser rollout. Webby feature-detects, so what browsers ship bounds what it can reach |
| `webmcp-declarative-explainer` | same repo → `declarative-api-explainer.md` | A proposed authoring surface Webby does not implement yet |
| `webmcp-types` | npm `webmcp-types` | Published type definitions; the cheapest signal that the tool descriptor shape moved |
| `mcp-spec` | `modelcontextprotocol/modelcontextprotocol` tags | Protocol revisions Webby advertises in `Webby.MCP.Protocol` |
| `webmcp-execute-tool` | `index.bs`, symbol presence | A *capability watch*: asks "has this arrived yet" rather than "has this changed", for an API Webby calls |
| `chrome-webmcp-status` | Chrome Status API | Chrome's shipping status for WebMCP |

The WebMCP spec has no releases or tags — it is a living Bikeshed document — so
it is tracked by content hash. The MCP spec publishes dated tags, so it is
tracked by tag, which also lets the checker answer a sharper question than
"did anything change".

Most contracts ask whether something changed. `webmcp-execute-tool` inverts
that: it records whether a symbol is *present* in the spec, so an API Webby
depends on but which upstream had not yet defined is watched for directly. It
fired on 2026-08-14, the day `executeTool()` was specified.

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

## Type-checking the extension

Tracking tells you a specification moved. It does not tell you whether Webby
still matches it — for that, `extension/tsconfig.json` type-checks every module
under `extension/src` against the published `webmcp-types` definitions and
`@types/chrome`:

```bash
cd extension && npm ci && npm run typecheck
```

This is a correctness check, not a build step: nothing is emitted. If upstream
renames a field the probe reads, CI fails with the exact property — rather than
the probe silently reporting an empty catalog on every page, which is how this
class of breakage would otherwise surface. Renaming `getTools` or
`RegisteredTool.inputSchema` in the definitions is verified to fail the check.

It earns its keep beyond the spec surface too. Enabling it across `src/` is
what found `tabs.map(scanTab)` in `scanAll()`: `Array.prototype.map` passes the
index as the second argument, so every tab after the first arrived with
`allowActiveTab` truthy and skipped `canScanTab` entirely — the check that
excludes incognito tabs, ineligible URLs, and origins the user never granted.
`scanning.js` tested that exclusion and passed; only the caller was wrong. That
specific mistake is now a type error.

Tests are excluded deliberately. They construct partial mocks on purpose — a
fake `RegisteredTool` has no `window` or `origin` — and demanding full shapes
there would be noise for no safety.

One deliberate exception is documented in the probe itself. The spec has only
ever spelled the field `inputSchema`, but the probe also tolerates a
`input_schema` at runtime in case a browser ships otherwise during origin
trial. That fallback reads through an explicitly loosened view so it cannot
stand in for the specified field — rename `inputSchema` upstream and the check
still fails.

## Where Webby sits relative to the spec

`executeTool()` — the API the invocation path depends on — **was specified on
2026-08-14** by [webmachinelearning/webmcp#226](https://github.com/webmachinelearning/webmcp/pull/226),
as:

```webidl
Promise<DOMString> executeTool(RegisteredTool tool, DOMString inputArguments,
                               optional ModelContextExecuteToolOptions options = {});
```

That is the call `invokeWebMcp` already made, including the `{signal}` option
used for cancellation. Before that day it was a TODO in the upstream README
with [#51](https://github.com/webmachinelearning/webmcp/issues/51) open since
2025-11-03; the `webmcp-execute-tool` watch above is what reported its arrival.

Two things still gate the feature end to end:

- **No browser implements it.** Feature detection stays, and Webby reports
  `webmcp_unavailable` rather than simulating invocation, per §21.
- **`webmcp-types` has not published a signature** (still 0.1.3, which predates
  the change), so `probe.js` reaches `executeTool` through a narrow cast. When
  the definitions catch up, that contract reports the version bump and the cast
  can go.

The same day, [#241](https://github.com/webmachinelearning/webmcp/pull/241)
changed `RegisteredTool.inputSchema` from `DOMString` to `object`. Webby
already accepted both, so nothing broke — origin-trial browsers still ship the
string form, which is why both are still handled.

## What Webby carries from a tool

Everything on `RegisteredTool` that a consumer could need to judge a tool is
carried through discovery and live sessions to `page.tools`, rather than
reduced to name/description/schema:

- **`annotations`** — `untrustedContentHint` is the page declaring its tool
  returns content it does not vouch for; `readOnlyHint` that the tool only
  reads. An MCP client cannot weigh either if the bridge strips them.
- **`origin`** — the origin of the document that *registered* the tool. The
  spec notes this "is only meaningful when the tool is cross-origin". A frame
  can expose tools into a page via `exposedTo`, so without this a third party's
  tool reaches an MCP client attributed to the page that merely embedded it.
  The dashboard badges any tool whose origin differs from its page.
- **`title`** — the display label, distinct from the identifier.

All of it arrives from a web page and is treated as untrusted: hints that are
not literally `true` become `false`, an `origin` that is not a well-formed
http/https origin becomes `""`, strings are control-stripped and bounded, and
the stored shapes are fixed so a page cannot smuggle extra keys into a catalog.

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

- **Chrome Status does not publish origin-trial expiry**, and its WebMCP entry
  disagrees with the spec repo: `implementation-status.md` cites a live origin
  trial in Chrome 149, while the Chrome Status API reports `status: Proposed`
  with `origintrial: false` and no milestones. The `chrome-webmcp-status`
  contract therefore tracks the shipping status — the signal that matters — and
  not expiry dates, which are not available there.
- `getTools()` is called without `fromOrigins` deliberately. Restricting to
  same-origin would silently drop tools a page intentionally exposed from a
  frame; instead each tool's `origin` is carried and surfaced, so a
  cross-origin tool is visible rather than either hidden or silently trusted.
