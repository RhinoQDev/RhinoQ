# Durable Runtime and Heavy Workload Gap Map

This map compares the Durable Task + Heavy Workload specification with the
current RhinoQ implementation. It intentionally maps to existing subsystem
names rather than creating a second runtime.

| Specification area | Existing RhinoQ subsystem | Status | Required work |
| --- | --- | --- | --- |
| Task/Execution, versions, retry, cancellation intent | Task profile, Executions, adapter contracts | integrated | Preserve the existing Task authority. |
| Durable `step()` identity, result, retry, fencing and reuse | PostgreSQL migrations 019/021, `DurableStepClient`, `context.step()` | implemented | Real-PostgreSQL fixture is enabled by `RHINOQ_TEST_DATABASE_URL`. |
| Long-running Step ownership | `renew_durable_step` fenced PostgreSQL command | implemented | `context.step()` renews while its callback is pending and refuses stale completion. |
| Parallel durable Steps | independent Step identities/leases plus `Promise.all` | implemented | No separate `parallel()` DSL is needed for independent Steps; successful siblings remain reusable. |
| External effects and unknown provider result | Go ProviderOperation ledger, verifier and reconciler | integrated | `context.effect()` remains a facade and blocks uncertain/not-happened results. |
| Progress and crash-safe cursor loops | progress coalescer and checkpoints | integrated | Checkpoints remain distinct from Step result state. |
| Large artifact outputs and streaming upload | artifact provider, `context.artifact.stream()`, direct multipart sessions | integrated | Providers own byte transfer; Node preserves checksum, bounded streaming and abort propagation. |
| FFmpeg process, readiness and cleanup | path/workspace media context and FFmpeg processor pack | implemented (path adapter) | A resumable stream-to-FFmpeg-to-artifact fixture remains unclaimed. |
| Resource-aware Step admission and capacity lease | PostgreSQL migration 020, resource pool/lease client and worker admission | implemented | Tenant-scoped capacity uses fenced leases; run real-PostgreSQL concurrent-admission coverage before rollout. |
| Task cancellation of active Steps | migration 021, Task-state monitor, `AbortSignal`, media abort handling | implemented | Only persisted user cancellation is terminal; adapter/deploy shutdown remains retryable. Run adapter integration coverage. |
| Durable multipart from worker pipeline | artifact upload sessions, `filePath()` and S3 direct multipart contract | implemented (replayable files) | A deterministic worker session reconciles S3 parts and registers only after readback. The source must be available and unchanged; arbitrary streams and stream-to-FFmpeg restart remain unclaimed. |
| Step-centric operator timeline/explanation | Flight Recorder, Workbench, Incident Explanation | implemented | Existing projections consume durable Step records without replacing execution/effect evidence. |
| Content cache, segment processing, automatic durable await, hardware selection, fault drill | no durable implementation | deferred P2 | Do not promote until P1 runtime/fault evidence exists. |

## Approved implementation decisions

1. **Resource scope:** PostgreSQL coordinates a tenant-scoped shared pool.
   `resource_pools` is locked for admission; leases are fenced by owner/epoch
   and expired leases are reaped in the next admission. A capacity mismatch
   for the same tenant/pool key fails closed.
2. **Abort meaning:** only authoritative `cancel_requested` creates
   `RhinoQUserCancellationError` and terminalizes an owned Step and Task. A
   generic worker signal becomes `RhinoQWorkerShutdownError` and is retryable.
   Effect completion remains ledger-governed.
3. **First heavy adapter:** the existing path/workspace FFmpeg context is the
   supported P1 adapter. It owns process abort and output verification; no
   stream-to-FFmpeg restart claim is made without its fixture.
4. **Worker multipart source:** reuse `ArtifactUploadService` and its persisted
   direct-upload session for a replayable file path. The built-in S3 provider
   uploads a missing part from that file, reconciles completion by readback and
   fails closed when the file checksum changes. A one-shot stream is not a
   recovery source.

Focused tests prove the Node-side boundaries. Real PostgreSQL concurrency,
selected-adapter retry/cancellation, and object-store/streaming-media fault
fixtures still require their environment fixtures.
