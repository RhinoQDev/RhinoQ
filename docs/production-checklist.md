# Production checklist

For direct/large artifacts also verify the following in a staging bucket:

- owner/tenant isolation and Task ownership rejection before URL signing;
- multipart interruption followed by resume without re-uploading known parts;
- completion readback mismatch/lost response remains `uncertain`;
- incremental SHA-256 completes for every Task-bound browser upload (or a
  trusted precomputed digest is supplied);
- upload-session expiry and artifact retention match business policy;
- retention is previewed, bounded, scheduled and alerts on `failed` cleanup;
- FFmpeg version/codecs, worker disk quota, cancellation and timeout are tested
  with the largest representative media file.

The synthetic artifact benchmark is not an S3 capacity result. Measure the
actual provider, region, file-size distribution and concurrency before sizing.

Artifact evidence commands:

```bash
npm --prefix sdks/node run lab:artifacts
npm --prefix sdks/node run test:s3
npm --prefix sdks/node run test:s3:fault
```

For FFmpeg, build `sdks/node/Dockerfile.media-worker`, verify readiness with
`inspectRhinoQMediaRuntime()`, then exercise invalid input, missing codec,
timeout/cancellation and the deployment's actual disk quota. The checked-in
image proves required packages and non-root defaults; quota enforcement remains
an orchestrator/storage responsibility.

This is the deployment go/no-go list. RhinoQ is still a prerelease, so passing
this checklist means **your deployment has accepted and tested its risks**; it
does not turn the project into a generally production-ready release.

Start with the [quickstart](./quickstart.md) if you have not completed one local
run. Read [production status](./production-readiness.md) for the evidence and
known product gaps behind this checklist.

## Choose the deployment shape first

| Deployment | Current decision |
|---|---|
| local evaluation | supported |
| controlled single-tenant pilot | possible after all required gates below pass |
| internal single-tenant production | requires explicit risk acceptance and deployment-shaped fault/restore evidence |
| public or hostile multi-tenant service | **no-go** while the full Go Gateway tenant-wide HTTP authorization gap remains |
| deployment needing an upstream production-support or availability SLA | **no-go**; RhinoQ is a prerelease and publishes no such SLA |

Do not apply a single-tenant decision to a multi-tenant deployment.

## Required gates

Every production-shaped deployment must pass all of these.

### 1. Pin and verify the release

- Pin `@rhinoq/node` or the Go binary/image to an exact version; do not use
  `latest` or `next` in deployment automation.
- Review the release checksum, signature/provenance and SBOM.
- Run the repository compatibility gate for the versions being deployed.

Pass condition: the artifact is immutable and the deployed PostgreSQL, Node,
Go, Redis and BullMQ versions are listed in the
[compatibility matrix](./compatibility-matrix.md), where applicable.

### 2. Use least-privileged PostgreSQL roles

- Never run application traffic as a PostgreSQL superuser or a role with
  `BYPASSRLS`.
- Separate runtime-write, Rule-read and backup roles.
- Set and verify tenant context on every tenant-scoped connection.
- Run `rhinoq doctor` using the same role and environment as the deployment.

Pass condition: `doctor` exits zero and the isolation tests pass with a
`NOSUPERUSER NOBYPASSRLS` application role. See [tenancy](./tenancy.md).

### 3. Rehearse migration and restore

- Back up before applying migrations.
- Review the migration plan; never edit applied migration history.
- Restore the backup into a separate database of the same PostgreSQL major
  version and run `scripts/restore-drill.sh`.
- Document the rollback/forward-fix owner and maximum acceptable restore time.

Pass condition: restore verification succeeds before the production migration.
See [migration recovery](./migration-rollback.md).

### 4. Protect every HTTP surface

- Keep the Gateway and Workbench private unless the application supplies
  authentication and authorization.
- Terminate TLS at a trusted proxy or load balancer.
- Apply network policy and a distributed edge rate limiter.
- Keep operator tokens, provider credentials and storage references out of
  browser HTML, JSON, logs and URLs.
- Exercise `/health/live`, `/health/ready` and metrics through the same network
  path used by the deployment.

Pass condition: unauthenticated and cross-owner/cross-tenant requests fail
without leaking resource existence, and credential rotation has been rehearsed.

### 5. Prove runtime failure behavior

- Run the parity and fault suites for every enabled runtime adapter.
- Test duplicate and out-of-order events, lost responses, process termination,
  dependency restart and multi-replica projector takeover.
- Run PostgreSQL, Redis and queue faults using the deployment's real topology,
  not only localhost containers.
- Define alerts for backlog growth, stuck work and unresolved `uncertain`
  outcomes.

Pass condition: Tasks converge without blind external-effect retry, and the
team has recorded evidence for its actual deployment topology. The local
[fault matrix](./fault-matrix.md) and
`scripts/run-failover-drill.ps1` are starting points, not substitutes for this
gate.

### 6. Bound data and operations

- Choose retention from the business dispute/audit window and run cleanup on a
  schedule.
- Set queue capacity, concurrency, request/body, page and timeout limits.
- Load-test the adopter's real Task sizes and fan-out shape.
- Alert before database, queue or delivery-ledger capacity is exhausted.

Pass condition: limits and retention are configuration, not undocumented
defaults, and the load test stays within the deployment's own SLO budget. See
[retention](./retention.md).

### 7. Write the incident runbook

- Assign owners for database, queue/runtime, provider and RhinoQ alerts.
- Document how to inspect `uncertain`, pause unsafe work and reconcile it.
- Require preview, fresh precondition, different approval, idempotency and a
  post-check for every repair callback.
- Rehearse the runbook without production credentials or data.

Pass condition: an on-call operator can detect, investigate, decide, repair and
verify a disposable incident without direct database editing.

## Conditional gates

Apply these only when the deployment uses the capability.

| Capability | Required proof before production |
|---|---|
| external provider mutation | provider-enforced idempotency, authenticated webhook or independent read-back, timeout/403/429/5xx tests, and retry only after `not_happened` evidence |
| object/file result | authorized server-side resolver, expiry and integrity policy, and no private storage reference in owner output |
| multi-tenant traffic | authenticated tenant resolution plus storage and HTTP cross-tenant denial; the current full Go Gateway gap makes a public hostile multi-tenant deployment no-go |
| multiple replicas | stable replica identity, durable projector/adoption store, lease takeover and stale-writer fencing test |
| native PostgreSQL queue | registered handler allowlist, unique worker identity, connection/admission budgets, lease/reaper timing, graceful shutdown and PostgreSQL failover evidence |
| notification delivery | durable destination, secret lookup, stable event ID, retry/dead-letter policy and a test against the actual delivery provider |
| operator repair | allowlisted callback, two different identities, durable idempotency fence, lost-response replay and post-apply verification |

## Useful but not a runtime blocker

These improve product quality but do not make the core runtime correct:

- saved operator filters and bulk triage;
- a design-partner code-reduction study;
- manual screen-reader usability review;
- external comparative benchmarks.

Accessibility may still be a legal or organizational release gate for your
product even though it is not a RhinoQ state-correctness gate.

## Release record

For each deployment, store:

- exact RhinoQ and dependency versions;
- migration plan and restore result;
- `doctor`, fault, isolation and load-test results;
- enabled adapters/providers and their conditional-gate evidence;
- accepted gaps, approving owner and review date;
- rollback trigger and on-call runbook link.

If any required or applicable conditional gate has no evidence, the decision is
`NO-GO` rather than “probably safe”.
