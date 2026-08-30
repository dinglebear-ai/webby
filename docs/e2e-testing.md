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
| Bounded stress qualification | `./scripts/e2e-repeat --seed=local-1 --repetitions=2 --concurrency=2` | 105 min |
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
- Nightly/manual stress qualification is initially nonblocking. Exhaustive
  functional and parity lanes remain blocking. Promote a stress lane only after
  its measured flake and runtime budgets are established by the stress epic.

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
central sanitizer, and creates a signed-by-digest upload attestation. CI uploads
only `e2e/artifacts/upload`, only on failure, and only when
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
worker reconnect loops, and artifact redaction. Deterministic fault qualification
covers SIGTERM, SIGINT, controller death, hung browser close, disk pressure and
recorder overflow by executing each fault through owned process, timeout, and
recorder quota seams. External cleanup must leave zero processes, listeners,
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

The initial local harness qualification (six synthetic orchestrator repetitions,
three concurrent isolated workers) measured 0/6 initial failures, 0 retry-passes,
and sub-10 ms p50/p95 orchestration overhead. These figures qualify the harness,
not live-service performance. The nightly report publishes live flake rate,
p50/p95/max duration, first failing seed, 100 pending-call and 10/100/1000 scan
ceilings, and worker concurrency. Promotion policy is:

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
