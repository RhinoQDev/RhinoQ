# Durable Task Runtime Roadmap

## Delivered P0 foundation

The Node Task profile now adds `context.step()` on top of the existing Task and
Execution model. Migration `019_durable_steps` stores a stable `(task, item,
step)` identity, task/step versions, attempt history, a fenced lease, bounded
JSON result or Artifact reference, and terminal state. Completed compatible
steps are reused; version drift, an active competing lease, and stale workers
are rejected by PostgreSQL.

`context.effect()` remains a narrow facade over the existing Go-owned
ProviderOperation Effect Ledger. It does not duplicate effect storage or retry
logic. Accepted, uncertain, and known-not-applied outcomes block Task progress
until the ledger and its verifier/reconciler resolve them.

Flight Recorder and Workbench receive the durable Step projection, and Incident
explanations include Step state as operator evidence. Existing checkpoints stay
separate: they are caller-owned bounded cursors, not Step state.

## Evidence and rollout gate

- Unit and contract tests cover compatible reuse, duplicate declaration,
  result encoding, effect uncertainty/not-happened guards, the public dispatch
  envelope, tenant-fenced schema registration, and Step timeline projection.
- `durable-step.integration.test.mjs` covers the real PostgreSQL migration,
  concurrent acquisition, stale-worker fencing, retry, and version mismatch
  whenever `RHINOQ_TEST_DATABASE_URL` is supplied.
- Migrations `020_shared_resource_leases` and
  `021_durable_step_cancellation` add tenant-fenced shared resource admission
  and terminal user cancellation. Focused tests cover client fencing, worker
  admission/release, lease-loss result discard, and user-vs-shutdown semantics.
- The built-in S3 provider exposes worker-part transfer through the existing
  artifact upload sessions. A replayable `filePath()` has a deterministic
  session identity per Task/Execution/Artifact, reconciles provider parts and
  fails closed when the source checksum differs. Completion retains the
  existing provider readback/`uncertain` policy before Task Artifact metadata
  is registered.
- This repository change does not apply migrations to an environment. A
  production rollout needs a backup, a staging migration run, the real
  PostgreSQL fixture, and an operator-approved deployment window.

## Explicit P0 limits

- `timeoutMs` is validation only. It does not interrupt arbitrary user code.
- `context.step()` renews its fenced PostgreSQL lease while a callback is pending
  and refuses to commit a result after renewal is lost; user cancellation is terminal.
- Effects carry Task and stable command identity into the existing ledger; the
  ledger schema has not been changed to add a Step foreign key.
- Large values must be registered as Artifacts; inline Step results are capped
  at 64 KiB.

## P1 after rollout evidence

1. Exercise resource-pool concurrent admission, expiry/reclaim and capacity
   mismatch through the real PostgreSQL rollout fixture.
2. Exercise user cancellation and retryable shutdown propagation through the
   selected adapter fixture, preserving Effect Ledger confirmation policy.
3. Extend direct `Promise.all()` Step support with adapter and real-fixture
   fault coverage, retaining reusable successes when a sibling fails.
4. Exercise S3-compatible worker multipart recovery against an object-store
   fixture, including a stop after provider acceptance, a provider-completion
   response loss, and an unavailable or changed replay source.
5. Run basic fault drills using the real NestJS + BullMQ + PostgreSQL/Redis
   fixture already used by the selected adapter profile.

## P2 only after P1 is proven

Experiment with compiler-assisted durable `await` boundaries only after the
explicit `context.step()` runtime has production fault evidence. It is not a
release blocker and must preserve the same stable identity, fencing, effect
confirmation, and observability contracts.
