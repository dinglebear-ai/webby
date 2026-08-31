# Live E2E testing

Webby's E2E package drives real loopback Phoenix/Bandit servers, SQLite files,
Phoenix Channels, MCP transports, the unpacked extension in Playwright's bundled
Chromium, and the LiveView dashboard. Unit and controller tests remain useful,
but they do not replace these process-boundary lanes.

## Setup

Install the versions pinned in `.mise.toml`, plus Node 22 and `lsof`. On macOS:

```bash
mise install
MIX_ENV=test mise exec -- mix deps.get
npm ci --prefix e2e
npx --prefix e2e playwright install chromium
```

GitHub Actions uses Ubuntu 24.04 and `playwright install --with-deps chromium`.
The committed npm lockfile is authoritative; `npm ci` fails lock drift. Before a
clean-checkout claim, run `npm install --package-lock-only --ignore-scripts
--prefix e2e` and confirm that it changes nothing. Native Windows is unsupported;
use Linux. macOS and GitHub Actions Linux use the same scenario IDs.

## Local commands

All policy lives in `e2e/package.json`. `scripts/e2e` and `mix e2e.*` are thin
forwarders.

| Purpose | Root command | Budget |
| --- | --- | ---: |
| Contract schemas and blocking coverage inventory | `./scripts/e2e validate` | 2 min |
| Workflow and shard contract | `./scripts/e2e ci:contract` | 2 min |
| PR protocol including denial and cancellation | `./scripts/e2e protocol:pr` | 35 min |
| Complete protocol lifecycle | `./scripts/e2e protocol:full` | 90 min |
| PR Chromium vertical slice plus denial/cancel | `./scripts/e2e chromium:smoke` | 40 min |
| Complete Chromium lifecycle | `./scripts/e2e chromium:full` | 90 min |
| Official MCP client compatibility | `./scripts/e2e mcp:compat` | 30 min |
| Inspect a sanitized replay | `./scripts/e2e replay PATH` | 1 min |
| Reap manifests and audit leaks | `./scripts/e2e cleanup` | 5 min |
| Bounded stress qualification | `./scripts/e2e-repeat --seed=local-1 --repetitions=2 --concurrency=2` | configuration dependent; CI cancels at 105 min |
| Exact stress replay | `./scripts/e2e-repeat --replay=PATH/replay-manifest.json` | scenario dependent |

PR lanes have one test worker and zero retries. A retry is never used to turn a
PR green. Main and nightly preserve first-failure evidence; any future diagnostic
retry must report the first pass as a flake rather than silently passing.

## CI tiers and promotion

- Pull requests block on inventory validation, protocol PR, Chromium smoke, and
  official-client compatibility. The workflow is `pull_request`, not
  `pull_request_target`, has read-only contents permission, persists no checkout
  credential, and receives no repository secrets from forks.
- Main and manual `main` runs execute the complete protocol and Chromium suites.
- Main and dependency-bearing pull requests run the pinned official MCP client.
- Nightly/manual stress qualification is nonblocking. Exhaustive functional and
  parity lanes remain blocking. Promote a stress lane only after measured flake
  and runtime budgets are established from retained CI samples.

Every job has an explicit timeout and concurrency policy. Cancellation is
followed by an `always()` external reaper and leak audit. Toolchain paths,
versions, and executable SHA-256 values are printed. Cache keys bind OS,
OTP/Elixir, Node, Playwright, `mix.lock`, and the E2E lockfile; browser profiles,
databases, and browser binaries are never cached.

The manifest command deterministically weight-balances the selected inventory.
It fails unless the shard union is complete and all intersections are empty, and
each shard emits its scenario, contract, and toolchain manifest. Scenario IDs do
not depend on operating system or job order.

## Failure evidence and secrets

The command runner keeps at most 8 MiB of test output, passes it through the
central sanitizer, and creates a digest-bound upload attestation. Functional CI
uploads only `e2e/artifacts/upload`; stress CI uses
`e2e/artifacts/stress/upload`. Both upload only on failure and only when an
`upload-attestation.json` exists. A sanitizer failure, missing attestation, or
post-attestation change produces no upload. There is no raw-artifact fallback.

The sanitized bundle may contain the bounded event journal, first-failure test
output, scenario/toolchain manifest, traces, screenshots, reports, fixture/Webby
logs, allowlisted SQLite diagnostics, transcripts, and cleanup reports. It must
not contain bearer tokens, pairing material, capability values, raw databases,
browser profiles, or arbitrary environment variables. Secret zones mechanically
disable browser capture. PR artifacts are retained 7 days; main/nightly artifacts
14 days. Per-file, scenario, and job limits are enforced by `ArtifactRecorder`
(8 MiB, 64 MiB, and 256 MiB defaults); scanner or quota failure closes uploads.

## Debugging and replay

Re-run the exact failing package command locally. The first error is the primary
signal; cleanup errors are reported separately. For Chromium, verify that
`npm run toolchains --prefix e2e` resolves the bundled executable and that no
system Chrome is substituted. Never edit a failure bundle or copy raw quarantine
into the upload directory. Download the sanitized artifact, then inspect it with:

```bash
./scripts/e2e replay path/to/sanitized-staging
```

If a process survives an interrupted run, invoke `./scripts/e2e cleanup`. The
reaper validates the private manifest, PID start identity, executable, working
directory, process group, and world nonce before terminating anything; identity
mismatches fail closed and require manual inspection.

## Stress qualification and promotion

Stress is an orchestration layer over the existing scenario IDs. It changes the
seed, order, worker concurrency, and repetition count; it does not maintain a
second behavior matrix. Each worker receives its own `TMPDIR`, database, browser
profile, and dynamically bound ports. The scheduled lane includes lifecycle and
removal ordering, the 100-call limit, 10/100/1000-tab scan ceilings, concurrent
resync/auth/audit/retention behavior, Webby restarts, Chromium context and MV3
worker reconnect loops, and artifact redaction. The blocking `test:stress` lane
qualifies deterministic process-tree, timeout, disk-pressure, recorder-overflow,
and redaction seams; those fast seam tests do not claim live-service termination
or real-browser cleanup. The scheduled `test:stress:live` lane separately sends
SIGTERM and SIGINT to nonce-verified process groups running real isolated Webby
worlds, preserves termination evidence, and proves external reaping leaves no
residue. It also launches a real persistent Chromium context, injects a hanging
`context.close`, forces bounded shutdown through the Chromium DevTools protocol,
and proves the browser processes and isolated profile are removed. External cleanup must leave zero processes, listeners,
profiles, databases, open handles, pending calls, or active stale sessions.
The external reaper accepts only a canonical private temporary root carrying a
run nonce marker and removes individually attested world directories; broad,
pre-existing, unmarked, or residual roots fail closed.

Every attempt gets an immutable `replay-manifest.json`. A later pass never
overwrites the first failure: the report classifies it as `retry_passes > 0`,
retains the first failing seed, and recommends `nonblocking-investigation`.
Replay exactly with the manifest command above. Replay preserves the recorded
seed and scenario order verbatim and rejects seed/scenario/concurrency overrides.
Only sanitized, hash-attested upload bundles are eligible for CI retention;
cleanup and evidence-integrity failures remain blocking.

Each stress report publishes the observed flake rate, p50/p95/max duration,
first failing seed, exercised pending-call and scan ceilings, and worker
concurrency. Pending-call and scan ceilings come from structured measurement
records emitted by the live capacity/concurrency scenarios and are compared
byte-for-byte with the finalized sanitized logs; registry declarations cannot
award ceiling credit. These values describe that recorded run; they are not
permanent performance baselines. Promotion policy is:

- Deterministic stress contract and leak-detector tests: blocking now.
- Single-seed live replay: blocking candidate only after 30 consecutive clean
  main runs with zero retry-passes and p95 below the documented 105-minute job
  budget.
- Multi-worker, high-volume Chromium, retention backlog, and fairness soak:
  scheduled nonblocking until 30 clean samples establish platform baselines.

Wall-clock budgets are cancellation ceilings, not brittle assertions. Functional
checks use exact invariant counts plus query/concurrency ceilings. A duration or
query regression must be compared to the preserved report before changing a
budget.
## Qualification telemetry and harness assurance

Every named suite writes `e2e/artifacts/suite-telemetry.json` with setup and
elapsed time, structured per-scenario durations, planned and observed scenario
IDs, attempts, retries, rerun rate, flake status, and evidence completeness.
The report deliberately excludes environment variables, command lines, hostnames,
and credentials. Full protocol and Chromium qualification remains mandatory on
pull requests; telemetry is evidence for future tuning, not a selector today.

The scheduled `harness-self-test` lane deliberately corrupts surface evidence,
telemetry accounting, and scenario input, then runs real Webby/Chromium tests for
extension generation, forced browser closure, process identity, RSS measurement,
artifact finalization, pairing persistence, manifest reaping, and isolated worlds.
Runtime adapter evidence comes from completed operation-boundary mappings and is
accepted only when observed IDs exactly equal the scenario declaration and every
ID is mapped by the canonical surface inventory.
