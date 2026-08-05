# tests/fault

Fault-injection evidence.

`AGENTS.md` forbids a throughput, latency or reliability claim without
benchmark or fault evidence. This directory was empty, which by RhinoQ's own
rule meant RhinoQ was not entitled to say anything about what happens when a
database drops mid-transaction, a lease expires under a live worker, or an
acknowledgement is lost after the write committed.

Run them with the rest: `make test`.

## What is covered

| Fault | Scenario | The guarantee under test |
|---|---|---|
| Ack lost after commit | `lost_acknowledgement_test.go` | The producer's retry finds the existing job instead of enqueueing a second one — with an idempotency key |
| Ack lost, no idempotency key | `lost_acknowledgement_test.go` | The duplicate is real and documented, not silently prevented |
| Ack lost on completion | `lost_acknowledgement_test.go` | A retried `Complete` is a no-op; a finished job never becomes claimable again |
| Lease expiry under a live worker | `lease_expiry_test.go` | Every write from the stale execution is fenced off; the live one still finishes |
| Network partition, then healing | `lease_expiry_test.go` | A renewal after the heal does **not** restore a lease another execution now owns |
| Sweep interrupted mid-batch | `lease_expiry_test.go` | No job is stranded in a leased state nobody holds |
| Confirmation lost after the provider succeeded | `effect_ledger_test.go` | A deterministic retry resolves against the ledger; it does not charge twice |
| Non-deterministic retry identity | `effect_ledger_test.go` | Refused, rather than recorded as a second charge for one invoice |
| Worker dies with an effect in flight | `effect_ledger_test.go` | The effect becomes `uncertain` — not failed, not succeeded |
| Next execution meets an uncertain effect | `effect_ledger_test.go` | It does not silently take the entry over as pending work |
| Notification lease takeover | `notification_scheduler_test.go` | A second node cannot send a live lease; after expiry it takes over and completes the durable delivery |

## What is not covered

Say this out loud rather than letting a green suite imply more than it proves:

- **These run against the in-memory adapter.** They pin the port contract and
  the application logic. They are not evidence about PostgreSQL's behaviour
  under the same faults — that lives in `tests/postgres`, against a real
  database.
- **No process-level crash.** Faults are injected at the store boundary. A
  `SIGKILL` between two statements is not simulated here.
- **No clock skew.** Every test drives an explicit clock. Two workers
  disagreeing about the time is a separate fault and is not covered.
- **No throughput or latency claim.** Nothing here measures anything. See
  `tests/benchmarks` and `docs/benchmarks.md`.
- **The in-memory notification test is not database evidence.** The real
  PostgreSQL lease takeover is covered by
  `tests/postgres/notification_scheduler_test.go`; Redis/BullMQ process
  restart is covered by the disposable demo harness. PostgreSQL failover,
  network partitions and a broader deployment campaign still need evidence
  before a production reliability claim.

## Adding a scenario

`inject_test.go` holds the injector. A `faultPlan` names the operation, the
call number, and — the part that matters — whether the failure lands *after*
the underlying store applied the write.

That distinction is the whole point. A failure before the write is benign:
nothing happened and the caller can retry freely. A failure after the commit
but before the acknowledgement leaves the caller unable to tell those apart,
and that is the case every at-least-once system actually has to survive. A
scenario that only injects `before` is not testing the interesting half.
