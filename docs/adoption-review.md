# Adoption and usability review

Reviewed: 2026-07-29.

This review asks whether a team can evaluate RhinoQ as a user-facing Task layer
for existing background work. It separates the current implementation from the
intended existing-worker adoption path.

## Current verdict

| Journey | Current state | Verdict |
|---|---|---|
| Go Task contract | public facade, PostgreSQL store and versioned snapshots | usable for controlled evaluation |
| HTTP/Node Task polling | typed source-only Node client and Gateway endpoints | technically usable; not published or tenant-safe |
| Existing BullMQ worker | external Execution reference can be written manually | not an adapter; no-cutover promise unproven |
| Native Go/PostgreSQL runtime | transactional enqueue, worker and operational tooling | usable for repository evaluation |
| Verified Tasks | Rules, Findings and read-only investigation | optional evaluation path, not the main onboarding path |
| Frontend experience | no React hook, Task Center, realtime or reconnect test | not ready |
| Production evidence | contracts exist; benchmark, fault, retention and auth evidence incomplete | not production-ready |

## The activation event that matters

The first meaningful Task Platform activation is not a job reaching
`succeeded`. It is a product team adding a second long-running feature and not
rebuilding task identity, status endpoints, stale-response handling, result
delivery and history again.

The optional Verified Tasks activation is separate: a real mismatch becomes a
deduplicated Finding with enough evidence to investigate. It should not be a
prerequisite for someone who only needs import/export progress.

## Adoption blockers

### P0 — required before recruiting existing-worker design partners

1. Ship one BullMQ reference adapter that creates/binds/observes Executions
   without moving correctness logic into an SDK or requiring a handler rewrite.
2. Add a two-task reference application and measure endpoints/files/LOC removed
   compared with hand-built task plumbing.
3. Define tenant/user scope and authorization before exposing Task reads,
   cancellation or result references to end users.
4. Publish a tagged Node package and prebuilt CLI binaries; the SDK is currently
   tested from source only.

### P1 — required for a credible frontend task experience

1. Add a small polling-first React hook or framework-neutral browser contract.
2. Test reload, delayed response, retry and stale/out-of-order update behavior.
3. Add cancellation/retry composition with command identity and crash recovery.
4. Add result payload delivery only after result-reference authorization is
   defined.

### P2 — only after the durable state model is validated

1. Realtime/SSE, streams and fan-out with polling as the convergence fallback.
2. Generic ProviderOperation validated against two providers with different
   polling/webhook semantics.
3. Benchmarks, fault campaigns, retention/partitioning and restore evidence.

## Measurement targets

These are design-partner measurements, not current claims:

- time from existing worker to first visible Task;
- number of business handlers changed during integration;
- status/result/UI glue removed for two Task types;
- stale/reconnect failures observed in browser tests;
- time for a user to get an authorized result or retry/cancel command;
- number of provider outcomes that correctly remain `uncertain` rather than
  being retried blindly.

The existing-worker thesis fails if adoption requires a worker rewrite, adds as
much glue as it removes, or teams prefer a hosted/runtime migration instead.
