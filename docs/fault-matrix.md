# Fault evidence matrix

`sdks/node/contracts/fault-matrix.json` is the machine-readable inventory of
16 fault scenarios and their executable evidence markers. Run:

```bash
npm --prefix sdks/node run fault:check
npm --prefix sdks/node test
```

The matrix covers SSE loss, polling fallback, stale/duplicate delivery,
capacity release, authorization, provider timeout, lost repair response,
dispatch/bind uncertainty, unsupported cancellation, secret redaction, tenant
isolation and PostgreSQL/projector interruptions.
The sixteenth scenario recreates a worker after a deterministic simulated
process death and proves it resumes from a checksum/handler-version-fenced
checkpoint instead of replaying completed segments.

The 2026-08-26 product-surface campaign, including complete Go package evidence
and new local PostgreSQL/Redis container evidence, is recorded in
[`evidence/task-center-product-campaign-2026-08-26.md`](./evidence/task-center-product-campaign-2026-08-26.md).
The current destructive local drills are recorded in
[`evidence/postgres-failover-2026-08-26.md`](./evidence/postgres-failover-2026-08-26.md)
and
[`evidence/redis-bullmq-chaos-2026-08-26.md`](./evidence/redis-bullmq-chaos-2026-08-26.md).

The current remediation run and its negative evidence are recorded in
[`evidence/remediation-campaign-2026-08-12.md`](./evidence/remediation-campaign-2026-08-12.md).
The independently containerized PostgreSQL primary/standby promotion result is
recorded in
[`evidence/postgres-failover-2026-08-12.md`](./evidence/postgres-failover-2026-08-12.md).

This is local deterministic and opt-in integration evidence. PostgreSQL and
deployment-shaped cases may skip without their explicitly documented service
configuration. Passing this matrix is not a production-readiness or reliability
claim; it prevents implemented evidence from silently disappearing.
