# Remediation campaign — 2026-08-12

## Provenance

- Base commit: `7c7e6b2e04d6d7fab14ac46589ed163901e942b3`.
- Subject: the uncommitted remediation diff described in `CHANGELOG.md`.
- Host: Windows 11, Node 22.22.1, local Docker services.
- This is local campaign evidence. It is not a throughput, availability or
  production reliability claim.

## Product evaluation

`rhinoq eval` reported `PASS` for PostgreSQL, Task schema v10, a durable
uncertain fixture, owner Task API, Task Center and Workbench. It reported
browser layout, external-provider readback and deployment faults as
`NOT VERIFIED`.

## Browser-shaped HTTP fixtures

- Report recovery: support preview returned HTTP 200; a separate approver
  reached recovery stage `verified`; repeating approval returned
  `replayed: true` without a second provider write.
- Notification fixture: the page recorded 204, 429, 503, 403 and timeout.
  These are local receiver stubs, not an external notification provider.
- Owner API: a PostgreSQL-backed Task was visible to its tenant/owner and
  returned 404 across either a different tenant or a different owner.

## BullMQ settlement

`RHINOQ_SMOKE_SIZES=50,50,100,200` and
`RHINOQ_SMOKE_SLOW_SIZES=50` produced five batches and 450 terminal items. Each
batch settled exactly once. The realistic run recorded four retries. This
validates the fixture's local lifecycle and race handling only.

## Redis restart

The chaos harness used a dedicated Redis 7 container, stopped it while one
BullMQ job was active, restarted it and removed the container after the run.
The Task and Execution converged to `succeeded`. Connection-refused evidence
was retained in `observedErrors`; the harness was then hardened so base Redis
connection errors are captured instead of emitted as unhandled events.

## Negative evidence and open work

- No external provider credentials were used.
- No multi-host network partition or split-brain campaign ran.
- No design-partner workload ran.
- Accessibility still needs screen-reader, reduced-motion and 200% zoom
  evidence in a real browser.
- Saved server-side views and bulk triage need a product contract defining
  ownership, sharing scope and which state mutations are safe in bulk.
