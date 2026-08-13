# Browser pairing and Channel protocol

## Phase 1: Durable pairing domain [COMPLETED]

- [x] [P1-T1][data] Added generation-2 browsers, pairing requests, exact decision/browser linkage, and bounded authentication challenges with SQLite constraints and expiry.
- [x] [P1-T2][domain] Implemented stale replacement, approval/rejection notification and recovery, revocation, idempotent challenge issuance, atomic replay prevention, and Ed25519 verification APIs.

## Phase 2: Versioned transport

- [x] [P2-T1][protocol] Implemented the version-1 transport-neutral envelope validator and stable protocol errors.
- [x] [P2-T2][channel] Added the size-bounded loopback Phoenix socket and pairing/authenticated browser channels with strict Chrome-extension origin validation.

## Phase 3: Local operator UI

- [x] [P3-T1][liveview] Added pairing approval, rejection, browser listing, and immediate revocation to the local dashboard.
- [x] [P3-T2][docs] Documented the slice contract and its explicit extension-scanning/MCP boundaries.

## Phase 4: Verification

- [x] [P4-T1][test] Added domain, protocol, Channel, LiveView, expiry, stale replacement, replay, revocation/disconnect, malformed payload, invalid-key, origin-policy, decision delivery, and reconnect recovery tests.
- [x] [P4-T2][verify] Passed formatting, warnings-as-errors, 44 tests, strict Credo, precommit, production release build, migration, dashboard/health, and shutdown smoke.
