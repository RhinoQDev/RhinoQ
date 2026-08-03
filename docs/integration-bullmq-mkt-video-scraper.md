# Integration report — RhinoQ into a real BullMQ application

Subject application: `api-mkt-video-scraper` (NestJS 11 + TypeORM + PostgreSQL +
Redis/BullMQ 5.71). It is a production video-scraping/download platform with a
credit system, not a demo written for this evaluation.

Status: **in progress**. Sections 1–4 are complete and evidence-backed.
Sections 5–12 are filled in as each gate produces evidence. Nothing in this
document is estimated; unmeasured items say "not measured" and why.

Evaluation environment (all measurements below refer to it):

| Component | Value |
|---|---|
| Host | Windows 11 Pro 26200, Node 22.22.1, Go 1.26.2 |
| App API | Docker `apivideoscan`, 1 container, port 8080 |
| App workers | Docker `api-mkt-video-scraper-worker-1..5`, 5 containers |
| App Redis | Docker `apivideoscan-redis`, port 6380 |
| App PostgreSQL | Docker `apivideoscan-database`, port 5433 |
| RhinoQ PostgreSQL | Docker `rhinoq-eval-db`, port 55432, schema 015/015 applied |
| RhinoQ Gateway | `rhinoq-agent` built from `main` @ `e762727`, `127.0.0.1:8099` |
| `@rhinoq/node` | source at `0.1.0-beta.2`; npm published tag is `0.1.0-beta.1` |

---

## 1. BullMQ architecture before integration

The application runs **9 BullMQ queues** registered in one module
(`src/libs/queue/queue.module.ts:74-84`), with producers and processors split
into `src/libs/queue/producers/` (9 files) and `src/libs/queue/processors/`
(8 files). Total queue-layer source: **3,508 lines**.

```
API container (apivideoscan)          Worker containers (x5)
  Nest HTTP (Fastify)                   Nest ApplicationContext
  ├── videos.controller.ts (2,094 LOC)  └── QueueModule only
  │     4 hand-rolled SSE endpoints           └── 8 @Processor classes
  ├── videos.service.ts (2,338 LOC)
  └── producers ──► Redis (BullMQ) ──────────► processors
                         │                          │
                    progress state             business writes
                    (Redis hashes)             (PostgreSQL)
```

Queue → job-name → retry policy, as registered:

| Queue | Job name | `attempts` | Backoff |
|---|---|---:|---|
| `bulk-scan` | `scan-item` | 1 | — |
| `video-download` | — | 3 | exponential 1s |
| `keyword-search` | `search-keyword`/`search-platform` | 3 | exponential 1s |
| `search-video` | `search-videos` | 3 | exponential 1s |
| `bulk-download` | `download-item` | 3 | exponential 1s |
| `channel-scan` | — | 3 | exponential 1s |
| `channel-discovery` | `discover-channel` | 3 | exponential 1s |
| `channel-metadata` | — | 2 | exponential 2s |
| `cleanup` | `cleanup-delete-unverified-user` | 2 | 60s |

Three architectural facts matter for this evaluation:

1. **Task state has no home.** There is no task table for most features.
   Progress lives in Redis hashes for `bulk-download`
   (`bulk-download:{batchJobId}:progress`, TTL 24h,
   `bulk-download.processor.ts:460-505`), in a dedicated `search_jobs` table for
   `search-video`, and is *derived by counting business rows* for `bulk-scan`
   (`videos.controller.ts:227-247`).

2. **The in-process EventEmitter cannot work across containers.**
   `sharedEventEmitter` (`src/libs/events/event-emitter.provider.ts`) is
   injected into both processors and the SSE controllers. Processors run in
   worker containers; SSE runs in the API container. Every
   `eventEmitter.emit(...)` in a processor is therefore **dead code in
   production topology** — the SSE endpoints in practice only ever deliver the
   1-second Redis/PostgreSQL poll. This is a pre-existing defect, not something
   the RhinoQ integration introduced.

3. **Cancellation does not exist.** `grep -rn "cancel"` over `src/libs/queue`
   returns nothing. The only `cancel` symbols in the app are payment/order
   states and a `JobStatus.CANCELLED` enum on an unused legacy `jobs` table.
   There is no API to stop a running or queued scan/download.

---

## 2. Why these two tasks

### Task A — `bulk-download` (deterministic, retryable, multi-step)

`POST /videos/bulk-download` → `BulkDownloadProducer.addBulkDownloadJob`
(`producers/bulk-download.producer.ts:16-57`) → N BullMQ jobs named
`download-item`, `jobId = ${batchJobId}-${i}` → `BulkDownloadProcessor`
(712 LOC).

Chosen because it is the app's heaviest real workload and satisfies every
Task-A criterion with *existing* code:

- **Multi-step:** resolve source URLs (with mirror fallback) → download →
  optional watermark removal → stream to S3 → per-item progress → batch ZIP →
  signed URL → email + in-app notification.
- **Genuinely transient failures:** source CDN URLs expire (YouTube stream URLs
  are re-fetched per attempt, `bulk-download.processor.ts:122`), mirrors fail
  individually. `attempts: 3` + exponential backoff is already configured.
- **Verifiable business outcome:** an S3 object per video plus
  `bulk-downloads/{batchJobId}/result.zip`. "Worker returned" and "the file
  exists" are independently checkable.
- **Real money:** credits are deducted per video inside a DB transaction.

It is also structurally a **fan-out**: one user-facing batch = N BullMQ jobs.
That shape is the common case in this app (3 of the 8 processors are fan-outs)
and, as section 10 records, it is the shape that breaks the current bridge.

### Task B — `search-video` (external provider, uncertain outcome)

`POST /videos/search` → `SearchVideoProducer.addSearchVideoJob`
(`producers/search-video.producer.ts:20-47`) → **one** BullMQ job
`search-videos` with `jobId = searchJobId` → `SearchVideoProcessor` (413 LOC).

Chosen because it is the app's clearest external-provider workload:

- **Third-party call on the critical path:** `providerImpl.search(...)` against
  Hyperapify (`search-video.processor.ts:166`), once per platform, in a loop.
- **Timeout after the provider has accepted the request is realistic and
  billable.** The provider charges per search request; the app charges the user
  credits *after* results come back (`search-video.processor.ts:340-360`).
- **Blind retry is already configured and already wrong:** `attempts: 3` with
  exponential backoff re-runs the whole platform loop, re-issuing provider
  searches that may have already succeeded and been billed. Nothing in the
  processor distinguishes "provider never received it" from "provider ran it and
  we lost the answer".
- **1:1 with a BullMQ job**, which contrasts deliberately with Task A's fan-out
  and gives the bridge its best case.

Together the pair covers both structural shapes (1:N and 1:1), both retry
policies that exist in the app (3 attempts, and effectively-1 for bulk-scan),
both progress models (counter-in-Redis and percentage-in-PostgreSQL), and both
outcome classes (locally verifiable artifact vs. externally-owned effect).

---

## 3. Lifecycle mapping table

BullMQ owns execution; RhinoQ owns the user-facing Task. The mapping actually
implemented is:

| BullMQ signal | RhinoQ Task state | RhinoQ Execution state | Note |
|---|---|---|---|
| job added (`Queue.add`) | `pending` → `queued` | `dispatched` (created+bound) | `track()` at enqueue time |
| `waiting` | `queued` | `dispatched` | idempotent |
| `active` | `running` | `running` | |
| `progress` | `running` (progress updated) | `running` | clamped, see §5 |
| `completed` | `succeeded` | `succeeded` | **not** outcome-verified |
| `failed`, attempts remain | *(unchanged)* `running` | `running` | fail-closed; bridge requires `isTerminalFailure` |
| `failed`, attempts exhausted | `failed` | `failed` | `isTerminalFailure() === true` |
| user retry | `failed`/`cancelled` → `queued` | new Execution | app-driven, not bridge-driven |
| user cancel, job still waiting | `queued` → `cancel_requested` → `cancelled` | — | app removes the BullMQ job |
| user cancel, job active | `running` → `cancel_requested` | — | **no acknowledged state**, see §10 |
| cancel loses the race | `cancel_requested` → `succeeded` | `succeeded` | **indistinguishable from plain success**, see §10 |

States RhinoQ has that the app never had: `pending`, `queued`, `cancel_requested`,
`cancelled`, plus a monotonic `entityVersion` per Task.

States the required contract asks for that RhinoQ does **not** have:
`cancellation_acknowledged`, `too_late`, `uncertain`, and any
"cannot cancel safely" signal. See section 10.

---

## 4. Baseline (before RhinoQ)

Every number below is counted from the source at commit `7d888f9`, not estimated.

### 4.1 Where lifecycle concerns live today

| Concern | Task A (`bulk-download`) | Task B (`search-video`) |
|---|---|---|
| Enqueue | `bulk-download.producer.ts:46` | `search-video.producer.ts:37` |
| Retry | BullMQ `attempts:3` only; no user-facing retry endpoint | same |
| Cancel | **does not exist** | **does not exist** |
| Progress store | Redis hash, TTL 24h | `search_jobs.progress` (int %) |
| Item results | Redis hash `:results` | `search_jobs.results` jsonb |
| Status read | `videos.service.ts:2061-2130` | `search_jobs` row |
| Push to client | SSE `videos.controller.ts:638-826` | SSE `videos.controller.ts:1796-1863` |

### 4.2 Files that must cooperate to display one task

Task A: **10 files** — `videos.controller.ts`, `videos.service.ts`,
`bulk-download.producer.ts`, `bulk-download.processor.ts`, `redis.service.ts`,
`s3.service.ts`, `bulk-download.dto.ts`, `queue.module.ts`,
`video-queue.constants.ts`, `event-emitter.provider.ts`.

Task B: **9 files** — `videos.controller.ts`, `videos.service.ts`,
`search-video.producer.ts`, `search-video.processor.ts`, `search-job.entity.ts`,
`search-job.repository.ts`, `video-history.entity.ts`, `queue.module.ts`,
`event-emitter.provider.ts`.

### 4.3 Lifecycle-related integration LOC

Counted as the contiguous regions that exist *only* to move a task through its
lifecycle and show it (SSE handlers, status assembly, progress writers). Not a
quality metric — a reference signal only.

| Region | LOC |
|---|---:|
| `bulk-download` SSE handler (`videos.controller.ts:638-826`) | 189 |
| `bulk-scan` SSE handler (`videos.controller.ts:185-432`) | 248 |
| `search-video` SSE handler (`videos.controller.ts:1796-1863`) | 68 |
| `channel-scan` SSE handler (`videos.controller.ts:911-…`) | not counted |
| status/progress assembly (`videos.service.ts:1953-2175`) | 223 |
| progress writer (`bulk-download.processor.ts:460-505`) | 46 |
| **Total for the two chosen tasks + the third SSE they share patterns with** | **774** |

### 4.4 Internal vs user-visible states

| | Internal | User-visible |
|---|---|---|
| Task A | BullMQ 5 (`waiting/active/completed/failed/delayed`) + Redis `status` 4 (`processing/zip_creating/completed/failed`) + per-item 3 (`pending/completed/failed`) = **12** | SSE `status` 5: `started/processing/completed/failed/timeout` |
| Task B | BullMQ 5 + `SearchJobStatus` 4 (`pending/processing/completed/failed`) + `ScanStatus` on the history header = **~12** | SSE `status` 4 + integer `progress` 0–100 |

Neither task exposes `queued`, `retrying`, `cancelling` or `uncertain` to the
user, because those states do not exist anywhere in the app.

### 4.5 Reload / reconnect behaviour

Recoverable, but only by full replay. Both SSE handlers keep their dedup sets
(`processedVideoIds`, `processedFailedIds`) and counters **in the closure of a
single HTTP connection** (`videos.controller.ts:204-207`, `671-674`). On reload
the client opens a new stream, receives `status:'started'` with
`processed: 0` again, and is re-sent every already-known item. The end state
converges; the intermediate display goes backwards to zero. Measured in §7.

### 4.6 What the user sees when a worker dies mid-job

Nothing changes. For Task A the Redis `progress` hash simply stops advancing and
the SSE poll keeps reporting the last counts until BullMQ's stalled-job check
re-queues the job (default 30s) or the **10-minute** SSE timeout fires. For Task
B the stream ends after **5 minutes** with `status:'timeout'`, a message that
does not distinguish a dead worker from a slow provider. There is no "the system
noticed" signal in either path.

### 4.7 Cancel semantics

Not applicable — cancellation is not implemented. There is no request, no
acknowledgement and no guarantee. Any future cancel would be a *request* only,
since neither processor checks a cancellation flag between steps.

### 4.8 "BullMQ says completed but the outcome does not exist"

Confirmed reachable in both tasks:

- **Task A:** `updateProgress(... 'completed' ...)`
  (`bulk-download.processor.ts:233`) writes the Redis counter after the S3
  upload, but the batch ZIP is produced later by whichever job finishes last
  (`createZipAndNotify`). If that job's process dies between the last item's
  counter increment and the ZIP upload, the Redis `status` stays `zip_creating`
  forever and the SSE stream reports progress `N/N` with no `zip_url`. Every
  item reads "success" while the deliverable does not exist.
- **Task B:** the provider search can succeed and the credit transaction commit,
  yet the `search_jobs.results` write happens in the same transaction — but the
  **error path sets `status = FAILED` before rethrowing**
  (`search-video.processor.ts:381-385`) while `attempts: 3` means BullMQ will
  retry. Between attempt 1 and attempt 2 the database reports a *terminal*
  `failed` state for a job that is merely waiting to retry, and a later
  successful attempt flips it back to `completed`. That is a false terminal
  state followed by a backwards transition, visible to the user.

### 4.9 Cross-tenant exposure at baseline

`GET /videos/bulk-download/:jobId` → `VideosService.getBulkDownloadStatus(jobId, _userId)`
(`videos.service.ts:2061`). The `userId` argument is **prefixed with an
underscore and never used**. The method reads the Redis hashes by `jobId` alone
and returns per-item `s3_key` plus freshly minted **24-hour presigned S3 download
URLs**. Any authenticated user holding the `VIDEO_BULK_DOWNLOAD` permission who
learns another user's `batchJobId` (a v4 UUID, so not enumerable, but it is
echoed in that user's API responses and SSE payloads) can read and download
another tenant's videos.

By contrast `getBulkDownloadVideos` *does* filter on `userId`
(`videos.service.ts:2148`), and the `bulk-scan` SSE filters on `user.id`
(`videos.controller.ts:229`), which shows the omission is an inconsistency
rather than an intentional design.

This is a **pre-existing defect in the application**, found during the baseline
survey and unrelated to RhinoQ. It is reported here because scenario 16 of the
compatibility gate targets exactly this path.

---

---

# Round 2 — contract retest against the fixed Gateway

Pinned versions for everything below:

| Item | Value | How verified |
|---|---|---|
| Gateway commit | `1915c26` (= `origin/main`) | `git rev-parse --short HEAD` |
| npm package | `@rhinoq/node@0.1.0-beta.2` | `npm ls @rhinoq/node` |
| npm dist-tags | `next` → `0.1.0-beta.2`, `latest` → `0.1.0-beta.1` | `npm view @rhinoq/node dist-tags` |
| PostgreSQL schema | `016/016 · 0 pending` | `rhinoq migrate apply` |
| Credentials | 1 operator + 2 owner tokens, 32 bytes each, all distinct | generated per run, never written to this file |

The RhinoQ repository was **not modified**. No `npm link`, no local tarball, no
local `dist/` — the app resolves the published registry artifact.

Environment note: the evaluation database initially carried a *draft* of
migration 016 whose checksum did not match the embedded SQL at `1915c26`. The
migration runner refused to proceed and named the mismatch precisely. The eval
database was dropped and rebuilt rather than editing migration history. This is
the runner behaving correctly and is recorded as a point in its favour.

## 5. Changes made

### 5.1 Application changes (this repository only)

| File | Status | Purpose |
|---|---|---|
| `src/libs/rhinoq/rhinoq.constants.ts` | added | Tracked job names, Task types, stable correlation-ID derivation |
| `src/libs/rhinoq/rhinoq.service.ts` | added | Operator client, Task create/read, aggregate progress + completion, cancellation commands |
| `src/libs/rhinoq/rhinoq-bridge.service.ts` | added | The two `BullMQTaskBridge` instances and real `isTerminalFailure` |
| `src/libs/rhinoq/rhinoq.module.ts` | added | Global module; inert when env vars are absent |
| `test/rhinoq/fanout.test.mjs` | added | GAP-4 fan-out proof against real BullMQ |
| `package.json` / `package-lock.json` | modified | `@rhinoq/node@0.1.0-beta.2` pinned exactly |

**Not yet done** (see §6 scope note): wiring the module into
`videos.service.ts` / the two processors, the owner-scoped Task HTTP endpoints,
the `search-video` false-`FAILED` fix, and the `getBulkDownloadStatus`
authorization fix. The integration module exists and typechecks; the call sites
are not yet edited.

### 5.2 Migration / compatibility impact

- Requires PostgreSQL schema **016**. 015 → 016 is additive
  (`016_task_cancellation_outcome.sql`); an already-applied draft of 016 will be
  rejected on checksum, which is intended.
- `TaskSnapshot` gained optional `ownerId` and `cancellation`. Additive for
  existing readers.
- **Breaking for end-user clients:** owner tokens are now rejected (401) on
  `/v1/jobs`, the generic `POST /v1/tasks/{id}/state` and every
  `/v1/task-executions/*` route. Any beta.1 client that used one token for both
  operator and end-user work must be split into two credentials.
- `@rhinoq/node` is ESM-only. This CommonJS Nest application cannot
  `require()` it (`ERR_PACKAGE_PATH_NOT_EXPORTED`); every entry point must use
  `await import()`.

## 6. Scenario results

**Scope of this round.** The mandated order was contract retest first
(Bước 4–7), then app integration (Bước 8+). Bước 4–7 are complete and
evidence-backed below. The 16 application-level scenarios and the browser
suite are **not yet run** — the integration module is written but not wired
into the request path, so there is no app endpoint to drive them through. They
are not reported as pass or fail; they are reported as **not run**.

Evidence scripts: `docs/evidence/gap1-owner-isolation.sh`,
`gap2-progress.sh`, `gap3-cancellation.sh`, and
`api-mkt-video-scraper/test/rhinoq/fanout.test.mjs`.

### Bước 4 — GAP-1 owner isolation

| # | Check | Expected | Actual | |
|---|---|---|---|---|
| 4.1 | owner-A GET own Task | 200 + `ownerId: tenant-a` | 200, `"ownerId":"tenant-a"` | PASS |
| 4.2 | owner-A GET own result | 200 | 200, reference returned | PASS |
| 4.3 | owner-A cancel own Task | 200 | 200, `cancel_requested` / `requested` | PASS |
| 4.4 | owner-A GET foreign Task | 404 | 404 `RHINOQ_TASK_NOT_FOUND` | PASS |
| 4.5 | owner-A GET foreign result | 404 | 404 `RHINOQ_TASK_NOT_FOUND` | PASS |
| 4.6 | owner-A cancel foreign Task | 404 | 404 `RHINOQ_TASK_NOT_FOUND` | PASS |
| 4.7 | owner-A `GET /v1/jobs` | 401 | 401 `RHINOQ_UNAUTHORIZED` | PASS |
| 4.8 | owner-A generic state → `succeeded` **on its own Task** | 401 | 401 `RHINOQ_UNAUTHORIZED` | PASS |
| 4.9 | owner-A execution lookup / create / bind | 401 | 401 on all three | PASS |
| — | symmetric repeat with owner-B | same | same | PASS |
| — | foreign-Task 404 vs nonexistent-Task 404 | byte-identical | byte-identical | PASS |

Cross-owner responses contain no foreign `ownerId`, `type`, result reference or
execution ID. Operator and end-user are genuinely separate capabilities: an
owner token cannot drive lifecycle even on a Task it owns.

Minor observation (not a failure): the 401 body is a long operator-facing
message naming the `RHINOQ_AGENT_TOKEN` environment variable and a `curl`
remediation. That guidance is aimed at a deployer but is returned to end-user
credentials.

### Bước 5 — GAP-2 progress invariants

| # | Write | Expected | Actual | |
|---|---|---|---|---|
| 5.1 | `5/10` at current version | 200 | 200, v3→v4 | PASS |
| 5.3 | `2/10` at current version | 409 `RHINOQ_PROGRESS_REGRESSION`, snapshot stays 5/10 | 409, same code, snapshot 5/10 | PASS |
| 5.4 | `6/12` after total 10 known | 409 `RHINOQ_PROGRESS_TOTAL_CHANGED` | 409, same code | PASS |
| 5.5 | `6/10` | 200 | 200, v4→v5 | PASS |
| 5.6 | stale `expectedVersion=2` | `RHINOQ_VERSION_CONFLICT` | 409, same code | PASS |
| 5.7 | identical `6/10` re-sent x3 | idempotent | 200 each; progress unchanged but **entityVersion 6→7→8→9** | **FAIL** — see GAP-5 |

### Bước 6 — GAP-3 cancellation outcome

| Scenario | Expected final | Actual final | |
|---|---|---|---|
| A — cancel succeeds | `cancelled` / `cancelled` | `state=cancelled cancellation={"status":"cancelled"}` | PASS |
| B — cancel too late | `succeeded` / `too_late` | `state=succeeded cancellation={"status":"too_late"}` | PASS |
| B control — never cancelled | must differ from B | `state=succeeded cancellation={"status":"none"}` | PASS |
| C — cannot cancel safely | `cancel_requested` / `cannot_cancel_safely` + actionable reason | exactly that; reason is operator prose, no payload/secret | PASS |
| D — retry after cancelled | new lifecycle from `none` | `state=queued cancellation={"status":"none"}` | PASS |
| Idempotency | duplicate cancel is a no-op | 200, entityVersion unchanged (v4 → v4) | PASS |

Scenario B is the headline fix: a cancelled-too-late Task is now
distinguishable from an uncancelled one, which it was not in beta.1.

### Bước 7 — GAP-4 fan-out

Real Redis + BullMQ 5.71 `Queue`/`Worker`/`QueueEvents` on db index 5 (isolated
from the application's running workers on db 0), the published bridge in
`terminalProjection: 'execution-only'`, real Gateway, real PostgreSQL.

```
[1] after enqueue + track x3            task=running   v10 progress=0/?  [item-0=succeeded item-1=dispatched item-2=dispatched]
[2] 1/3 executions succeeded            task=running   v12 progress=0/?  [item-0=succeeded item-1=running    item-2=dispatched]
[2] 2/3 executions succeeded            task=running   v15 progress=1/3  [item-0=succeeded item-1=succeeded  item-2=running]
[2] 3/3 executions succeeded            task=running   v17 progress=2/3  [item-0=succeeded item-1=succeeded  item-2=succeeded]
[5] all items done, before CompleteTask task=running   v18 progress=3/3  [item-0=succeeded item-1=succeeded  item-2=succeeded]
[9] after application CompleteTask      task=succeeded v20 progress=3/3  [item-0=succeeded item-1=succeeded  item-2=succeeded]
```

| Check | Expected | Actual | |
|---|---|---|---|
| 3 jobs → 3 distinct Executions | 3 | 3 | PASS |
| item 1 succeeded → Task | still `running` | `running` | PASS |
| item 2 succeeded → Task | still `running` | `running` | PASS |
| item 3 real transient failure + BullMQ retry | Task not terminal | `running`; `attemptsMade` reached 2 | PASS |
<!-- The retry row above is a record of what this run observed, not the
current contract. At the time, a BullMQ retry reused its job ID and left no
RhinoQ record, so item 3 stayed at one Execution. Since the per-attempt
history change the same run produces four Executions -- item 3 attempt 1
failed, attempt 2 succeeded -- and the "3 jobs → 3 distinct Executions" row
would read 3 items / 4 attempts. Re-running this proof would update the
numbers; the observations are kept as they were made. -->
| all 3 succeeded, bridge only | still `running` | `running` at v18 | PASS |
| aggregate artifact verified before completion | exists | verified on disk before the call | PASS |
| application `CompleteTask` | now `succeeded` | `succeeded` at v20, `hasResult` true | PASS |
| duplicate completion events | no duplicate Execution, no double count | 3 → 3 executions | PASS |
| progress across the run | never decreases | 0 → 1 → 2 → 3, total pinned at 3 | PASS |

**Honest scope limit:** the job handler in this proof performs real work and
produces a real artifact, but it is a purpose-built worker, not the
application's `BulkDownloadProcessor`. Running the real processor requires live
S3 credentials, real video fixtures and real credit deduction against user
data, which this round did not set up. The queue, retry, event, bridge, Gateway
and store paths are entirely real and unmodified; the *business* handler is
not. Scenario 6 of the compatibility gate ("ZIP exists") is therefore proven
for the aggregate-completion contract, not for the app's real S3 ZIP path.

## 7. Experience measurements

**Not measured.** These require the integration wired into the app's HTTP
surface and a client driving it; neither exists yet in this round. No p50/p95,
sample count, enqueue-to-visible or reconnect-recovery numbers are reported,
because inventing them would be worse than leaving them empty.

The one timing observation available: in the fan-out run the bridge moved the
Task from `pending` to `running` before the first sampling tick, i.e. under the
150 ms sample interval. That is a single unreplicated observation on one host,
not a latency measurement.

## 8. Backend/frontend code removed or simplified

**None yet.** No application lifecycle code has been deleted, because the call
sites are not yet migrated. The 774 lines of baseline lifecycle code in §4.3 are
all still present and still executing. Test and documentation files added in
this round are explicitly *not* counted as backend reduction.

## 9. Complexity RhinoQ adds

Measured from this integration, not estimated:

- **A second datastore.** PostgreSQL 16 with its own migration lineage (016),
  separate from the application's database. One more thing to back up, migrate
  and monitor.
- **A separate process.** `rhinoq-agent` must be built from Go source, run,
  health-checked and restarted with the app. No published binary or image was
  used here; the CLI/agent are not distributed on npm.
- **Three credentials instead of zero.** One operator token plus one token per
  tenant, each ≥32 bytes, each requiring rotation policy. The owner-token model
  is per-owner, so a real multi-tenant deployment needs credential issuance the
  application does not currently have.
- **ESM-only package in a CommonJS app.** Every touch point must use
  `await import()`; the client cannot be constructed in a plain constructor.
- **Bridge lifecycle.** Two extra `QueueEvents` Redis connections, plus
  `track()` at every enqueue site and `close()` on shutdown.
- **The aggregate coordinator is the application's job.** `execution-only`
  correctly refuses to guess batch completion, so the application must own
  "when is this batch really done", including after a crash between the last
  item and the completion call. RhinoQ removes the wrong-answer risk; it does
  not remove the work.
- **Net for this application so far:** 4 new source files (~330 LOC) added,
  0 removed.

## 10. Bugs and contract gaps found

Confirmed against the running Gateway (`rhinoq-agent` @ `e762727`) + real
PostgreSQL before any application code was written. Reproduction script:
`docs/evidence/rhinoq-contract-probe.sh`.

### GAP-1 — Task ownership is not enforced and not even readable

`POST /v1/tasks` accepts `ownerId`, but `TaskSnapshot` does not return it
(`internal/contracts/task/snapshot.go`, verified in the probe output) and
`GET /v1/tasks/{id}` applies no owner check. Any holder of the single Gateway
bearer token reads any Task. This is consistent with `.ai/STATUS.md`
("Tenant-scoped user authorization — not implemented"), but the consequence for
an adopter is sharper than the status line suggests: because `ownerId` is
write-only, the application **cannot even implement its own filtering from a
snapshot** — it must keep a parallel task→owner table, which is one of the
things the Task layer was supposed to remove.

### GAP-2 — Progress is not monotonic, and version-safety does not make it so

Probe: `progress {completed:5,total:10}` at `entityVersion` 3 → accepted
(`entityVersion` 4). Then `progress {completed:2,total:10}` at `entityVersion` 4
→ **accepted** (`entityVersion` 5). `task.Record.ApplyProgress`
(`internal/domain/task/record.go:90-104`) overwrites `Progress` with no
comparison to the previous value.

The documented rule is "every write uses the latest `EntityVersion`, so a stale
browser or worker response is rejected". That defends against *stale* writers.
It does not defend against *fresh, correctly-versioned, out-of-order* writers —
which is precisely what N concurrent BullMQ jobs reporting into one Task are.
For Task A the user-visible progress bar can move backwards without any stale
read occurring. The adapter must clamp; RhinoQ does not.

### GAP-3 — `too_late` is not representable

Probe: `running` → `cancel_requested` → `succeeded` is a legal path
(`internal/domain/task/state.go:38`), and the resulting snapshot is
`{"state":"succeeded"}` — byte-identical to a task nobody tried to cancel. A
user who pressed Cancel is shown plain success, with no signal that the cancel
lost the race and the effect happened anyway. The required contract states
`cancellation_acknowledged` and `too_late` have no representation, and there is
no "cannot cancel safely" signal at all.

### GAP-4 — The BullMQ bridge assumes one Task per job; fan-out corrupts the Task

`BullMQTaskBridge.complete()` calls `ensureTask(execution.taskId, 'succeeded')`
(`sdks/node/src/bullmq/task-bridge.ts:221`) unconditionally. A Task may hold many
Executions (`createTaskExecution` is plural by design), but the **first**
Execution to complete drives the whole Task to `succeeded`. For Task A — one
batch of N `download-item` jobs bound to one Task — the Task reports success
when 1 of N videos is done, and `succeeded` is terminal
(`state.go:40`, `Succeeded: {}`), so the remaining N−1 completions can never be
reflected.

The documented limitation is that the bridge "does not model a BullMQ retry as a
new Execution". The fan-out limitation is *not* documented, and it is the more
damaging one for this application: 3 of its 8 processors are fan-outs. Either
the adopter models each item as its own Task — which pushes the aggregation glue
back into the frontend, defeating the stated value — or it must bypass the
bridge's completion path entirely.

### Status after the `1915c26` / `beta.2` retest

| Gap | Status | Basis |
|---|---|---|
| GAP-1 owner authorization | **fixed** | 11/11 checks in Bước 4, symmetric, no existence leak |
| GAP-2 progress monotonicity | **partially fixed** | 5.1–5.6 pass; 5.7 duplicate-idempotency fails → GAP-5 |
| GAP-3 cancellation result | **fixed** | scenarios A–D + idempotency all pass; `too_late` distinguishable |
| GAP-4 fan-out completion | **fixed** | `execution-only` proven against real BullMQ with a real retry |

### GAP-5 (new) — identical progress writes are not idempotent

`POST /v1/tasks/{id}/progress` with a value equal to the current one returns
200 and **advances `entityVersion`** while leaving `progress` unchanged.
Reproduced deterministically: three identical `{completed:6,total:10}` writes
moved the Task v6 → v7 → v8 → v9.

Reproduce:

```bash
curl -s -X POST -H "Authorization: Bearer $OP" -H 'Content-Type: application/json' \
  "$GW/v1/tasks/$T/progress" -d '{"expectedVersion":6,"progress":{"completed":6,"total":10}}'
curl -s -X POST -H "Authorization: Bearer $OP" -H 'Content-Type: application/json' \
  "$GW/v1/tasks/$T/progress" -d '{"expectedVersion":7,"progress":{"completed":6,"total":10}}'
```

Expected: a no-op write leaves `entityVersion` unchanged, as duplicate
`POST /v1/tasks/{id}/cancel` already does (verified: v4 → v4).
Actual: `entityVersion` increments on every identical write.

Why it matters for an adopter:

- `watchTask()` yields only strictly newer versions, so each no-op write
  delivers a fresh snapshot with identical content — spurious UI renders.
- A concurrent writer holding the previous version receives a
  `RHINOQ_VERSION_CONFLICT` caused purely by a no-op.
- BullMQ redelivers `progress` events on `QueueEvents` reconnect, so duplicates
  are the normal case in a fan-out, not an edge case.

The application-side workaround used here is to read the snapshot and skip the
write when nothing changed (`rhinoq.service.ts: syncAggregateProgress`), but
that is a read-before-write race, not a fix. The inconsistency with the
cancellation endpoint — which *is* version-idempotent — suggests this is an
oversight rather than a deliberate contract.

Severity: medium. Not a correctness break; it is a churn and
spurious-conflict problem that grows with fan-out width.

## 11. Conclusion

**Conditional value, and the condition is now much better met than in beta.1.**

The four gaps this evaluation raised were real, and three are properly fixed in
the domain rather than papered over in the Node adapter — `execution-only` is a
genuine contract, not a flag that suppresses a symptom, and `too_late` as a
cancellation dimension orthogonal to Task state is the right model. The owner
authorization split is the strongest of the four: an owner token cannot drive
lifecycle even on its own Task, which is exactly the operator/end-user
separation a task layer needs.

What the evidence does **not** yet support is the product claim. This round
proved the *contracts* against a real Gateway and real BullMQ. It did not prove
that the application gets smaller: zero lines of the 774-line baseline
lifecycle layer have been removed, four new files were added, and a second
datastore, a second process and a three-credential model were introduced. On
the evidence available today the honest statement is that RhinoQ now has a
lifecycle contract worth adopting, and an unproven adoption cost.

## 12. beta.2 go/no-go

**NO-GO for a compatibility-gate pass — but the blockers are evidence gaps, not
contract defects.**

Note that `0.1.0-beta.2` is already published to npm under tag `next`; this is
not a decision about whether to publish, but about whether the compatibility
gate can be declared met. It cannot, yet.

Met:

- RhinoQ contract tests pass (Bước 4–7 above).
- App typecheck passes with 0 errors against the published types.
- Fan-out does not complete early — proven with real BullMQ and a real retry.
- Progress does not run backwards; total cannot change.
- Cancellation result is never lost and `too_late` is distinguishable.
- Cross-tenant read and mutation are blocked, with no existence leak.
- The published artifact resolves and imports (`npm ls` clean; no link/tarball).

Not met — outstanding blockers:

1. **The two tasks do not run end-to-end through the application.** The
   integration module is written and typechecks but is not wired into
   `videos.service.ts` or the processors. Bước 8 was not reached.
2. **The 16 application scenarios were not run.** Reported as not run, not as
   pass.
3. **Browser reload / reconnect / dual-tab were not tested.** This application
   has no frontend at all, so this needs either a frontend or an explicitly
   labelled HTTP-client proxy suite.
4. **No UX measurements.** No p50/p95 exist.
5. **GAP-5 is open** (medium severity).
6. **Two known application defects remain unfixed**: `search-video` writing a
   terminal `FAILED` while BullMQ retries remain, and the missing ownership
   check in `getBulkDownloadStatus`.
7. **`npm pack` into a clean app was not run** — the registry install was
   verified instead, which covers the artifact but not a from-scratch project.

Recommended next step: wire the module into the two call sites, fix the two
application defects, then run the 16 scenarios and the measurements. That is
the remaining distance to a gate decision, and none of it requires another
RhinoQ change except GAP-5.
