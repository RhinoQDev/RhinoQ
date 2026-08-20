# Backlog cải tiến: chi phí tích hợp thấp nhất + hiệu năng tốt nhất

Bản tổng hợp mọi điểm cần sửa, gộp từ ba nguồn và **đã kiểm chứng lại bằng code**
(không nhận claim suông — bài học từ `report_test.pdf`):

1. Đợt chống nghẽn N1–N10 (đã xong, đã merge PR #17) — bối cảnh.
2. Report tích hợp (TTS) — 7 finding về ma sát DX. **Cả 7 đã verify là có thật.**
3. Phân tích trong phiên — mục tiêu hiệu năng còn lại (T1–T5) và các cải tiến tự suy ra.

Bắc đẩu định hướng: **giảm sâu nhất chi phí tích hợp, và hiệu năng tốt nhất** — hai
trục, xếp theo (tác động × bằng chứng × rủi ro thấp).

## Trạng thái report Issue #06

Các finding DX trong report Issue #06 được đối chiếu lại với code beta.21:

- F-01 và F-05 đã sửa: lỗi thiếu schema có `RHINOQ_TASK_SCHEMA_MISSING` và
  `definitionVersion` mặc định là `1` ở hai Node client.
- F-02 đã sửa bằng `TaskHandle`, `reportTaskProgressAutoVersion()` và giữ
  `RHINOQ_VERSION_CONFLICT` khi có race; SDK không tự retry mù.
- F-04 đã được sửa ở cả `TaskHandle.start()` và low-level
  `transitionTask(..., 'running')`: khi snapshot hiện tại đúng là `pending` và
  đúng `entityVersion`, client tự gửi hai command có version fence theo
  `pending -> queued -> running`; state machine authoritative vẫn ở runtime/
  database.
- F-03 đã có `createTaskWorker({ client, type, handler })` cho một Task đã được
  runtime chọn. Helper validate type, giấu version, serialize progress và ghi
  outcome; không tự poll/claim/lease/retry. Với worker runtime đầy đủ, dùng
  `defineRhinoQApplication()` + `workerHandler()`/`runWorker()`.
- API matrix `completeTask()` đã có ở Gateway và PostgreSQL client, là helper
  composition có version fence; không quảng bá nhầm là một transaction atomic.

Các claim benchmark về LOC/thời gian chỉ nên giữ khi log và bảng tổng hợp dùng
chung một nguồn số liệu; report hiện có chênh lệch giữa hai phần này.

Riêng Case 3.1 trong report ghi “SDK Auto-Retry” là diễn giải quá mức: Node
client chỉ phân loại lỗi kết nối là retryable, không tự retry lệnh đã có thể
commit. Đây là chủ ý fail-safe để không nhân đôi side effect khi mất
acknowledgement; caller phải reconcile hoặc chỉ retry command idempotent.

---

## Phần 0 — Đã xong (để khỏi làm lại)

| # | Nội dung | Đo được |
|---|---|---|
| N1 | Khoá advisory theo item cho `claim_item_effect` | 1748→228ms |
| N2 | Trigger cấp lệnh + gộp bump version | 8→4 ghi/item |
| N3 | Lệnh ghi trả `{version}`, bridge dùng đường rẻ | 6.2→0.2MB |
| N4 | `pg_notify` + hub `LISTEN` cho SSE | 200→0 q/s |
| N5 | Cấu hình pool 3 binary Go + `doctor` | hết churn |
| N6 | `withTenant()` — một pool đa tenant | RLS thật |
| N7 | Gộp `NextQueueRateLimitTTL` | 30→1 query/tick |
| N8 | `lock_timeout` đường ghi + timeout cấp role | có biên |
| N9 | Keyset pagination | hết lặp row |
| N10 | Rate limiter theo credential | công bằng |
| S1 | `OwnerFacingTaskStore` chặn bề mặt không fence | compiler chặn |
| S2 | `assertTenantId` regex ở biên | chặn injection |

---

## Phần 1 — Giảm ma sát tích hợp (7 finding, đã kiểm chứng)

Đây là trục **quyết định adoption** — vì một tool tối ưu runtime mà lắp vào khổ thì
không ai dùng.

### F1 · Nest + PostgreSQL-only vẫn bị ép có BullMQ `QueueEvents` — 🔴 P0

**Xác minh: CÓ THẬT.** `RhinoQTaskIntegrationOptions.events: BullMQQueueEvents` là
**bắt buộc** ([integration.ts:95](../../sdks/node/src/integration.ts)), và
`createRhinoQTaskIntegration` truyền thẳng `options.events` vào `BullMQTaskBridge`
([integration.ts:142](../../sdks/node/src/integration.ts)). Nest module
([nest.ts:58](../../sdks/node/src/nest.ts)) chỉ gọi đúng hàm này.

**Nguyên nhân gốc:** Nest module **chỉ có một đường tích hợp — đường BullMQ bridge**.
Không có composition PostgreSQL-only cho Nest. Nên adopter không dùng BullMQ buộc
phải fake `mockQueueEvents` — abstraction bị rò rõ ràng. Câu hỏi của developer hoàn
toàn hợp lý: *"Tôi không dùng BullMQ thì tại sao phải truyền QueueEvents?"*

**Hướng sửa (suy từ cái đã có):** `installPostgresTaskProfile(pool)` **đã** cho Task
client đầy đủ mà không đụng BullMQ. Chỉ cần một biến thể Nest module dựng đúng cái đó
+ HTTP surface, không dựng `BullMQTaskBridge`:
```ts
RhinoQModule.forRootAsync({ mode: 'postgres', useFactory: () => ({ pool }) })
// không cần events; không dựng bridge
```
Đường BullMQ giữ nguyên cho ai cần fan-out qua BullMQ.

**Việc phải làm TRƯỚC khi code:** xác định kiến trúc chủ đích. **PostgreSQL-only có
phải supported path không?** Positioning hiện tại (`repository-metadata`, README) nói
*"PostgreSQL queue"* nên **câu trả lời gần như chắc là CÓ** → không được bắt
QueueEvents. Đây là finding mạnh nhất, ưu tiên cao nhất trục DX.

### F4 · Error `RHINOQ_PROGRESS_STATE` quá nghèo — 🟠 P1 (quick win, làm sớm)

**Xác minh: CÓ THẬT.** `fail('RHINOQ_PROGRESS_STATE', v_task.state)`
([task-schema.ts:215,1121](../../sdks/node/src/postgres/task-schema.ts)) — DETAIL chỉ
là chuỗi state trần, ví dụ `pending`. Developer không được nói sai gì, state nào hợp
lệ, bước tiếp theo là gì.

**Điểm hay:** RhinoQ **đã có sẵn mẫu error tốt** — migration V7 dựng `fail_version()`
với operation + cả hai version + next action. Chỉ là **chưa áp mẫu đó cho
progress-state**. Nên đây không phải phát minh mới, mà là *áp mẫu đã tồn tại*:
```
RHINOQ_PROGRESS_STATE: cannot report progress while task is 'pending';
report progress only in 'running'/'cancel_requested'.
Transition the task to 'running' first.
```
kèm error fields `{ code, currentState, allowedStates, nextAction }`.

**Vì sao P1 làm sớm:** rủi ro kiến trúc ~0, tác động DX trực tiếp, và nó vá đúng sự
*không nhất quán* (error version giàu, error progress nghèo).

### F6 · AWS SDK kéo theo dù adopter PostgreSQL-only — 🟠 P1

**Xác minh: CÓ THẬT.** `@aws-sdk/client-s3`, `lib-storage`, `s3-request-presigner` là
**dependency cứng** ([package.json](../../sdks/node/package.json)), không phải
optional. Adopter chỉ dùng Postgres vẫn tải ~AWS SDK.

**Điểm quan trọng tôi tìm được:** **code ĐÃ lazy-import** — `artifact-storage.ts` dùng
`optionalImport('@aws-sdk/...')`. Nghĩa là runtime không cần AWS trừ khi bật S3. Vấn
đề **chỉ nằm ở `package.json`** khai báo chúng là hard deps nên npm cài bất kể.

**Hướng sửa:** vì code đã lazy, chuyển AWS SDK sang **`peerDependencies` (optional)**
hoặc tách `@rhinoq/artifacts-s3` riêng. Wording đúng như reviewer: *"tách artifact/S3
khỏi footprint core"*, không phải chỉ đổi thành optionalDependency. P1 nghiêng
optimization, không blocker.

### F2 · Happy path lộ quá nhiều lifecycle low-level — 🟠 P1 (nghiên cứu API cao hơn)

**Xác minh: CÓ THẬT.** Đường thủ công lộ `createTask` → `createTaskExecution` →
`transitionTask('queued')` → `bindTaskExecution` → `transitionTaskExecution` →
`reportTaskProgress` → `attachTaskResult` → `transitionTask('succeeded')`.

**Sắc thái cần thêm:** `BullMQTaskBridge` (`dispatch`/`track`) **đã** là API cao che
hết chuỗi này — nên ma sát chỉ ở người dùng `PostgresTaskClient` **trực tiếp**. Vậy
vấn đề tách hai nhánh:
- **Producer đơn giản:** cần một facade cao, ví dụ `rhinoq.dispatch(type, input)` trả
  handle, worker context tự quản `queued → running → success`.
- **Đã có bridge:** cần *quảng bá/tài liệu hoá* đường cao đó rõ hơn, vì nó đã tồn tại.

Không cần theo đúng đề xuất `startTask()` của report — nhưng **problem là thật**: một
developer muốn "background export report" không nên phải biết `Execution`,
`bindTaskExecution`, `entityVersion` ngay lần tích hợp đầu. Đây là research API, không
phải quick fix.

### F3 · OCC / `entityVersion` tạo cognitive load ở common path — 🟠 P1 (SDK design)

**Xác minh: CÓ THẬT.** Mọi lệnh ghi nhận `expectedVersion`; caller phải thread version
mới qua từng call, giữ snapshot cho lần sau.

**Đồng ý với reviewer, không đồng ý với TTS gốc:** **không** auto-retry version
conflict (có thể phá semantics — đúng như reviewer cảnh báo). Thay vào đó, một **task
handle có state** tự cập nhật version nội bộ:
```ts
const task = await client.openTask(id);
await task.reportProgress(...);   // version thread ngầm bên trong
```
hoặc worker context `await ctx.progress(...)`. **Giữ nguyên OCC bảo vệ correctness,
chỉ giấu việc thread version khỏi common path.** Đây là hướng đáng phát triển, liên
quan chặt F2 (cùng là "nâng abstraction").

### F5 · `moduleResolution: node10` fail với subpath `/nest` — 🟡 P2

**Xác minh: CÓ THẬT về cấu trúc.** `exports['./nest']` dùng conditional exports
(types/import/require) — `node10` không hiểu `exports` subpath, nên
`@rhinoq/node/nest` không resolve được; `node16`/`nodenext`/`bundler` thì OK.

**Hướng sửa:** không cần support `node10` bằng mọi giá. Nhưng `npx rhinoq setup` nên
**đọc `tsconfig.json` và cảnh báo trước**:
> `moduleResolution=node10` không dùng được `@rhinoq/node/nest`; đổi sang `node16`,
> `nodenext` hoặc `bundler`.
thay vì để developer gặp lỗi TypeScript khó hiểu. DX có evidence rõ.

### F7 · Nest injection ergonomics — 🟡 P2 (convenience)

**Xác minh: hợp lý.** Hiện `@Inject(RHINOQ_TASKS)`. Một decorator `@InjectTaskClient()`
đẹp hơn, discoverable hơn. Không blocking. P2, nâng lên P1 nếu user-testing thấy Nest
dev vướng thường xuyên.

---

## Phần 2 — Hiệu năng còn lại

### T1 · Đọc snapshot O(N) — ảnh gương của N3 — 🟠 P1 (bằng chứng mạnh)

`getTask()`/`SNAPSHOT_SQL` vẫn `jsonb_agg` mọi execution không giới hạn, gọi từ 7 chỗ.
N3 sửa đường *ghi*; đường *đọc* là hình gương chưa sửa. Task 100k item mở trang chi
tiết = kéo 100k hàng mỗi lần. **Làm được ngay không cần đợi đo** — bằng chứng cấu trúc
y hệt N3 đã chứng minh. Sửa: mặc định summary + execution phân trang (đã có
`listTaskExecutions`), mảng đầy đủ chỉ khi hỏi rõ; thêm `getTaskIfNewerThan(id, ver)`
để bỏ hẳn serialize O(N) khi client đã ở version mới nhất.

### T2 · Query Claim của engine Go — 🟠 P1 nhưng CẦN ĐO trước

Query đa-CTE chạy mỗi vòng poll của mỗi worker. Ứng viên rõ nhất bên Go **nhưng chưa
có số**. Đừng động dao trước P0-0.

### P0-0 · Benchmark bão hoà — 🟠 công cụ, mở đường mọi thứ khác

Mở rộng `bench/postgres-benchmark.mjs`: fan-out 2k/10k, lấy mẫu `pg_stat_activity`
(chờ Lock), đường cơ sở BullMQ, đo cả Claim của Go. **Biến T2–T5 từ nghi ngờ thành thứ
tự có số.** Đây là kỷ luật `ARCHITECTURE.md §8`.

### T3–T5 · Dài hạn, kích hoạt theo quy mô — 🟡 P2

- **T3** read model tách cho Console/reconciler khi history đè write path.
- **T4** partition `executions` theo thời gian + dọn superseded (giờ không prune).
- **T5** chính sách payload lớn: inline JSONB vs object storage.

Chỉ làm khi **đo được** chạm ngưỡng.

---

## Phần 3 — Cải tiến tự suy ra (giảm chi phí tích hợp + trần hiệu năng)

Không copy từ đâu — suy từ primitive RhinoQ đã có.

### C1 · Preset file — ✅ XONG (nhưng khác kế hoạch ban đầu)

**Kiểm code phát hiện: composition ĐÃ tồn tại sẵn.** `createRhinoQApp` tự nối toàn
bộ đường file khi có `artifactProvider` hoặc `artifacts: 's3'`:
`app.ts:130` tự nối `resolveArtifact` từ `provider.resolve`; `app.ts:257-258` tự
nối upload service (multipart) + retention. Nên xây `createRhinoQFiles` mới = **code
thừa** — đúng kỷ luật "đừng thêm cái đã có".

Lỗ hổng thật, nhỏ: `artifacts: 's3'` **chỉ đọc env**, không truyền config inline được.
Đã vá: `artifacts` nay nhận `'s3' | { s3: AwsS3ArtifactOptions }` — cùng một call nối
cả đường file (upload + download + retention) nhưng config truyền thẳng trong code cho
host dùng secrets-manager thay vì env. 4 test.

Phần còn lại của C1 là **discoverability** (adopter tự lắp tay vì không biết
`artifacts: 's3'` làm hết) — thuộc về docs, không phải code.

### C2 · Zip stream THẲNG vào S3 multipart — 🟡 P2 (trần hiệu năng)

Nối đầu ra `archiver` ([declaration.ts:481](../../sdks/node/src/tasks/declaration.ts))
trực tiếp làm đầu vào S3 multipart (`lib-storage` nhận stream). Zip 50GB → **O(1) cả
RAM lẫn đĩa**. Có sẵn cả hai nửa, chỉ cần nối.

### C3 · Dedup theo nội dung dùng checksum đã tính — 🟡 P2

Upload đã tính `checksumSha256`. Hai Task ra cùng nội dung (thường gặp ở report/export)
→ hash đã tồn tại thì link thay vì upload lại. Tiết kiệm băng thông + storage.

### C4 · Nối `TaskChangeHub` → `wsHub.invalidate()` — 🟡 P2

Hoàn tất nốt N4 cho WebSocket (mới làm cho SSE): độ trễ 500ms→~ms, tải DB chỉ khi có
đổi. Kèm cải tiến an toàn: nhánh no-owner của `invalidate`
([websocket.ts:79](../../sdks/node/src/tasks/websocket.ts)) nên kiểm cả `tenantId`.

### C5 · `rhinoq_task.explain(task_id)` — 🟡 P2 (nam châm chuyển đổi)

Merge-sort mọi bằng chứng đã lưu (entityVersion đơn điệu, attempt history, effect
claims, verifications, lineage) thành một dòng thời gian nhân quả duy nhất. Read-only
projection, không storage mới, không migration rủi ro. Là luận điểm "status xanh có
thể nói dối → đây là bằng chứng" biến thành một câu gọi.

---

## Phần 4 — Backlog ưu tiên (gộp tất cả)

| Ưu tiên | Mục | Trục | Rủi ro |
|---|---|---|---|
| ✅ **XONG** | **F1** — Nest PostgreSQL-only không đòi QueueEvents (`forPostgresAsync` + `createPostgresTaskIntegration`, 5 test) | tích hợp | thấp (thêm đường, không phá cũ) |
| ✅ **XONG** | F4 — error progress giàu thông tin (migration 18 + `nextAction`, 2 test) | tích hợp | ~0 (quick win) |
| ✅ **XONG** | F6 — tách AWS khỏi footprint core (optional peer, shipped `deps: {}`) | tích hợp | thấp (code đã lazy) |
| ✅ **XONG** | T1 — đọc snapshot O(N): `getTaskIfNewerThan` (35KB→19 byte khi current, 5 test) | hiệu năng | thấp (additive, ảnh gương N3) |
| ✅ **XONG** | F2+F3 — `TaskHandle` + `openTask()`: giấu lifecycle + tự thread version, giữ OCC (9 test) | tích hợp | trung (additive) |
| ✅ **XONG** | C1 — file path: composition đã có sẵn; thêm inline config `artifacts: { s3 }` (4 test) | tích hợp | thấp |
| P1* | P0-0 — benchmark bão hoà | công cụ | thấp |
| P2 | F5 — `rhinoq setup` cảnh báo moduleResolution | tích hợp | ~0 |
| P2 | F7 — `@InjectTaskClient()` | tích hợp | ~0 |
| P2 | T2 — Claim query (sau khi đo) | hiệu năng | trung |
| P2 | C2/C3/C4/C5 — trần hiệu năng + explain | cả hai | thấp |
| P2 | T3/T4/T5 — read model, partition, payload | hiệu năng | trung, theo quy mô |

*P0-0 để P1 nhưng thực chất nên chạy song song sớm — nó xếp hạng T2–T5.

### Thứ tự thực thi đề xuất

1. **F1** — gỡ blocker Nest PostgreSQL-only. Đây là lời hứa đang bị vỡ.
2. **F4 + T1** cùng đợt — hai quick win, một DX một perf, rủi ro thấp.
3. **C1 + F6** — hạ ngưỡng tích hợp cho ca file (preset + footprint nhẹ).
4. **P0-0** — dựng thước đo.
5. **F2+F3** — research API cao hơn (đợt riêng, thiết kế kỹ).
6. Còn lại theo số liệu P0-0.

---

## Phần 5 — Nguyên tắc (đừng quên)

1. **Đo trước, sửa sau** cho mọi mục hiệu năng (`ARCHITECTURE.md §8`). T2 "trông phức
   tạp" ≠ là nghẽn — đúng lỗi report gốc.
2. **Đừng cố thắng ca tối thiểu.** Overhead cố định (Postgres + migration) luôn thua
   script 30 dòng. Làm ca-vượt-ngưỡng gần drop-in (C1), và **nói rõ ranh giới** trong
   docs. Với sản phẩm lòng tin, thành thật ngay chỗ không hợp = được tin chỗ hợp.
3. **Không nhận claim suông.** Cả 7 finding report này đã verify bằng code — khác
   `report_test.pdf`. Giữ kỷ luật đó cho mọi report sau.
4. **F1 cần quyết định kiến trúc trước khi code:** PostgreSQL-only có phải supported
   path chính thức không? Nếu có (gần như chắc), nó là P0 thật sự.
