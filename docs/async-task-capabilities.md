# Async Task capability map

This page separates implemented behavior from the next engine work. A manifest
field or process-local timer is not counted as a production capability.

## Implemented

| Capability | Owner | Application Compiler |
|---|---|---|
| Single Task dispatch | runtime adapter + durable Task profile | typed `dispatch()` |
| Bounded fan-out | runtime adapter + durable Executions | `task.batch()` and `dispatchBatch()` |
| Retry/backoff | selected runtime | explicit bounded policy |
| Delay and priority | capability-advertising adapter | explicit execution policy |
| Progress | runtime event projection | handler context and SSE/polling UI |
| Cancellation | capability-advertising adapter | mounted API/UI |
| Result/artifact access | Task profile + private S3-compatible/Cloudinary provider | buffered/stream/filePath + output presets + mounted API/file UI |
| Human/input/webhook waits | durable PostgreSQL waitpoints | existing waitpoint helpers/UI |
| External-effect safety | effect/provider evidence | `task.external()` requires policy |
| Worker registration | selected runtime | generated map or fail-closed router |
| NestJS lifecycle | Nest container | `forApplicationAsync()` |
| Health/readiness/metrics/reconciliation | engine/integration | standard mounted surface/setup |

## Not yet a generic production capability

| Capability | Why it is not marked implemented | Required completion evidence |
|---|---|---|
| Recurring business Tasks/cron | Interval and five-field IANA-timezone cron, lifecycle, native queue dispatcher, migrations 031–032, payload-free Workbench controls and real-PostgreSQL takeover/DST evidence exist | adopter deployment evidence before production promotion |
| Task dependency graph/DAG | callbacks after success can lose events or dispatch twice | durable dependency records, atomic settlement/outbox, cycle/bound tests, recovery tests |
| Portable per-Task concurrency/rate limit | native queue has queue-level controls, but adapters expose different guarantees | capability contract plus BullMQ/native/SQS conformance tests |
| Universal timeout | aborting JavaScript does not prove an external effect stopped | runtime deadline contract and uncertain-result handling tests |

These gaps are deliberately not represented as accepted Task options. Doing so
would reduce visible code while creating false production guarantees.

## Recommended engine sequence

1. Durable recurring schedule: one Task occurrence has a deterministic identity;
   PostgreSQL claim leases use database time and survive replica takeover.
2. Dependency edge as an outbox-driven settlement projection, initially only
   `all_succeeded` and `always`, with cycle and fan-out bounds.
3. Extend runtime capabilities for queue-level concurrency/rate-limit profiles;
   reject any adapter that cannot prove the requested policy.
4. Only then add short compiler syntax and generated UI for these capabilities.
