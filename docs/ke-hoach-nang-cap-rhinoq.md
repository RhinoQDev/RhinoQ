# RhinoQ Next — kế hoạch nâng cấp chuẩn low-code async

Đây là tài liệu sản phẩm chuẩn cho giai đoạn sau public beta. Mục tiêu không
phải thêm nhiều subsystem mà làm đường đi từ business handler đến production
ngắn, an toàn và đo được hơn rõ rệt.

Một mục trong tài liệu này chỉ là đề xuất cho đến khi có code, test, example,
README/changelog và bằng chứng tương ứng. Không dùng tài liệu này để quảng bá
behavior chưa phát hành.

## Lời hứa sản phẩm

> Adopter viết business handler và các quyết định correctness không thể suy
> đoán; RhinoQ tự tạo integration, execution policy, data path, API/UI,
> observability và recovery quanh handler đó.

RhinoQ không được đạt “low-code” bằng generated code khổng lồ mà adopter phải
bảo trì. Kết quả phải làm giảm tổng:

```text
source code + config + process + dependency + runbook do adopter sở hữu
```

## Ngân sách phức tạp bắt buộc

Mọi golden-path capability phải thỏa **negative code budget**:

```text
phần tích hợp adopter được xóa
>
phần tích hợp adopter phải thêm
```

Quy tắc cụ thể:

- cấu hình chung chỉ viết một lần ở project profile;
- một Task bình thường chỉ cần tên và handler;
- một lựa chọn phổ biến dùng một factory hoặc preset, không dùng object nhiều
  tầng;
- health, metrics, progress transport, reconnect và recovery không có config
  trên từng Task;
- generated manifest thuộc RhinoQ, không được tính là code adopter đã viết;
- expert override không xuất hiện trong quickstart;
- tính năng thêm 20 dòng nhưng chỉ xóa 10 dòng không được vào golden path;
- business logic, authentication và correctness rule vốn thuộc ứng dụng không
  được tính giả là code RhinoQ đã loại bỏ.

Mục tiêu cần được fixture và `rhinoq measure` xác nhận:

| Workload | Code tích hợp mục tiêu, không tính business handler |
|---|---:|
| Task thông thường | 2–5 dòng |
| Xuất một artifact | 3–8 dòng |
| Video/file lớn | 5–12 dòng |
| Batch fan-out | 4–10 dòng |
| Health, metrics, realtime, recovery trên mỗi Task | 0 dòng |
| External effect nguy hiểm | dài hơn có chủ ý vì phải khai báo safety |

Đây là target, chưa phải claim hiện tại.

## Audit hiện trạng từ góc nhìn adopter

| Khu vực | Đã giảm code | Khoảng trống phải đóng |
|---|---|---|
| Setup | preview-first setup, schema, doctor, integration shell | còn cần tự động chọn và mount capability đã phát hiện trong một project profile |
| Task declaration | typed registry bỏ worker switch và lặp adapter/runtime/scope | low-level declaration vẫn dài; tài liệu phải đưa nó xuống advanced path |
| Retry/correctness | retry boundary, effect identity, `uncertain`, verification | safety choice vẫn rải rác; cần factory chuyên biệt và một evidence passport |
| Realtime | SSE/polling và WebSocket Hub đã có | mutation invalidation, browser multiplex/reconnect và framework mount chưa tự động hoàn toàn |
| File/media | direct upload, streaming, workspace, artifact và FFmpeg helper | processor wiring/readiness vẫn cần nhiều bước; chưa có data-path plan thống nhất |
| Batch | fan-out, progress và partial result đã có | progress write có thể quá dày; resource budget và admission chưa cùng một profile |
| UI/operations | Task Center, Workbench, metrics, repair và incident evidence | trải nghiệm còn tách rời; chưa có một causal Task view và compiled-plan preview |
| Bằng chứng | fault lab, benchmark command và code measurement đã có | chưa có baseline adopter chuẩn chứng minh net reduction cho từng workload |

## Tác dụng bắt buộc phải nhìn thấy từ phía adopter

| Slice nâng cấp | Adopter chỉ còn viết/vận hành | RhinoQ phải loại bỏ |
|---|---|---|
| Project profile | database/runtime/storage và một identity hook | mount API/UI, schema wiring, health, metrics, SSE và recovery timer riêng lẻ |
| Short Task factory | tên và business handler | registration, dispatcher, worker routing, lifecycle/progress/result plumbing |
| Automatic realtime | không có code trên từng Task | manual invalidation, socket subscription protocol, reconnect và polling debounce |
| Progress coalescer | gọi `context.progress()` tự nhiên | throttle timer, overlapping writes và frame storm protection trong handler |
| Processor pack | business transform và specialist option | readiness, workspace, stream, cleanup, cancellation, artifact và metric glue |
| Integration Eraser | review/apply một preview diff | tự tìm và gỡ status route, polling hook, queue listener, upload proxy và recovery cron |
| Evidence Passport | business verification callback khi cần | tự join attempt/effect/artifact/provider/finding để điều tra một Task |
| Data Path Planner | object/file và hard constraint khác mặc định | tự chọn inline/reference/multipart, buffer limit, workspace và transfer path |
| Developer Console | authentication/authorization hook | tự xây Task dashboard, incident join, realtime diagnostics và plan diff UI |

Một slice không được coi là hoàn thành nếu example vẫn cần adopter tự viết phần
được ghi ở cột “RhinoQ phải loại bỏ”.

## Golden path mục tiêu

### 1. Project profile viết một lần

API minh họa, chưa phải public contract:

```ts
export default rhinoq.project({
  database: pool,
  runtime: postgres(),
  storage: s3(),
  identity: fromSession((session) => ({
    ownerId: session.user.id,
    tenantId: session.org.id,
  })),
});
```

Profile này tự mount owner API, Task Center, Workbench, health, readiness,
metrics, SSE và realtime fallback. Credential đọc từ environment/provider
chain; không ghi secret vào manifest.

Nếu `setup` phát hiện BullMQ, S3 hoặc NestJS, nó sinh preview cho đúng adapter
và hook shell. Nó không ghi đè và không tự chọn identity từ query string.

### 2. Factory ngắn thay cho manifest dài

RhinoQ không quét source handler và không chạy thử business code để đoán
capability. Compiler lấy metadata từ factory rõ ràng nhưng ngắn:

```ts
export const exportReport = rhinoq.task(
  'report.export',
  async ({ reportId }) => generateReport(reportId),
);

export const resizeImages = rhinoq.batch(
  'image.resize',
  async (image, context) => resize(image, context.signal),
);

export const webVideo = rhinoq.media(
  'video.web',
  async (video, context) => context.media.transcode(video, 'web'),
);
```

Factory `task`, `batch`, `media`, `schedule` và `effect` là capability marker
được type-check, không phải workflow DSL. Chúng giúp compiler biết requirement
trước dispatch mà không bắt adopter viết `intent` object.

Safe default có hard bound. Chỉ workload khác chuẩn mới override:

```ts
rhinoq.media('video.web', handler, { workspace: '40GB' });
```

Object `Execution Capsule` dài là **output nội bộ** để preview/test/deploy,
không phải API người dùng mặc định.

### 3. Effect nguy hiểm phải dài hơn có chủ ý

Không rút gọn bằng cách đoán retry hoặc idempotency:

```ts
export const capturePayment = rhinoq.effect('payment.capture', {
  key: ({ orderId }) => orderId,
  run: ({ orderId }) => stripe.capture(orderId),
  confirm: ({ orderId }) => stripe.readBack(orderId),
});
```

Factory tự nối effect ledger, unknown-result handling, reconciliation,
metrics, Finding và operator action. Adopter chỉ cung cấp business identity,
provider call và confirmation mà RhinoQ không thể phát minh.

### 4. Một lệnh từ repository đến green run

```bash
npx rhinoq setup
npx rhinoq setup --apply
npx rhinoq dev
```

`setup` phải:

1. phát hiện framework/runtime/database/storage;
2. đề xuất một project profile;
3. tìm Task declaration cũ và integration plumbing có thể thay thế;
4. in diff và net code/config/process dự kiến loại bỏ;
5. chỉ apply khi adopter xác nhận;
6. chạy migration, doctor, fixture và smoke test;
7. in URL Console và lệnh rollback.

Không tạo service trung gian bắt buộc cho ứng dụng nhỏ.

## Execution Capsule — RhinoQ tự sinh gì

Từ project profile và factory metadata, compiler sinh manifest versioned gồm:

- runtime/queue path và capability requirements;
- admission, priority, concurrency/rate envelope;
- lease, heartbeat, timeout, cancellation và retry boundary;
- inline/reference/direct-upload input strategy;
- workspace, memory, disk, codec và data-locality requirements;
- artifact/output, progress/realtime, health và metrics wiring;
- recovery/reconciliation command, runbook và deployment checks.

Console hiển thị ba nhóm:

```text
Detected       RhinoQ chứng minh được từ profile/factory
Selected       safe default hoặc preset đã chọn
Needs decision correctness/risk mà RhinoQ không được đoán
```

UI có thể tạo preview patch cho source-controlled project profile. UI không âm
thầm đổi production policy và tạo một nguồn config thứ hai.

## Những điều chỉ hỏi khi thật sự cần

RhinoQ không hỏi adopter cấu hình SSE heartbeat, retry polling, progress
throttle hoặc multipart concurrency trong golden path. Nó chỉ hỏi khi thiếu:

- external/irreversible effect retry policy;
- provider idempotency và confirmation identity;
- business outcome được coi là đúng;
- data residency hoặc contractual deadline/cost cap;
- recovery action cần approval;
- hard resource limit khác safe preset.

Thiếu safety decision phải fail-closed hoặc hiện `Needs decision`, không tự
điền một giá trị trông có vẻ hợp lý.

## P0 — Tối ưu ngay đường chạy hiện có

### Automatic realtime

- Tự phát invalidation sau mọi Task mutation; application không gọi
  `hub.invalidate()` bằng tay.
- PostgreSQL `LISTEN/NOTIFY` là adapter multi-process mặc định khi dùng
  PostgreSQL; Redis/NATS chỉ là optional invalidation bus cho scale lớn.
- Browser client dùng một connection cho nhiều Task, tự resubscribe và fallback
  SSE/polling.
- `setup` sinh mount cho `ws`, NestJS hoặc Socket.IO đã có; không bắt cài một
  WebSocket stack mới.
- Đo mutation-to-delivery, coalesced read, fan-out ratio, buffered bytes và
  missed-signal recovery; không dùng claim “zero latency”.

### Progress coalescer

Handler được phép gọi `context.progress()` thường xuyên. RhinoQ tự:

- giữ newest progress trong memory có bound;
- flush theo time/percentage threshold;
- luôn flush terminal progress;
- không cho stale progress ghi đè version mới;
- giảm DB write và realtime frame mà không yêu cầu handler tự debounce.

Phải fault-test process crash giữa hai lần flush và ghi rõ độ phân giải progress
có thể mất, trong khi Task correctness không mất.

### Processor packs thật sự tùy chọn

Các package riêng cho Sharp, FFmpeg, LibreOffice, malware scanner và AI model
chỉ cung cấp phần lặp lại:

- readiness/capability check;
- workspace, streaming input/output và cleanup;
- cancellation/timeout;
- artifact registration và metrics;
- deterministic error classification.

Business transform/prompt/model choice vẫn thuộc handler. Import một pack không
kéo các processor khác vào bundle hoặc image.

### Integration Eraser

```bash
npx rhinoq adopt --scan
```

Scanner chỉ đọc repository và tạo report có evidence:

```text
Detected: status routes, polling hooks, BullMQ listeners, upload proxy, retry timer
Replaceable estimate: 7 modules / 412 high-confidence matching lines
Still application-owned: auth, handler, business verification
```

Scanner chỉ tạo report preview có confidence và file/line evidence; không tạo
diff, không tạo rollback patch, không tự xóa code. Điều không chắc phải đánh dấu
review và không được tính vào code-reduction claim. Human review quyết định
patch migration nào thực sự an toàn.

## P1 — Proof-carrying Task

Mỗi terminal Task tự có một `TaskEvidencePassport` nối:

- input identity/checksum;
- Task/definition/handler version;
- attempts và runtime evidence;
- effect confirmation hoặc `uncertain`;
- artifact checksum/readback;
- business verification và Finding;
- recovery/audit history.

Adopter không tạo passport bằng tay. Existing lifecycle, artifact, verification
và effect records được project thành một owner/operator-scoped view. Passport
giúp API/UI trả lời riêng:

```text
technical execution succeeded?
external effect confirmed?
business outcome achieved?
```

Không nhét provider secret, raw file hoặc unbounded log vào passport.

## P1 — Data Path Planner

Planner tối ưu byte path từ metadata của factory, artifact provider và runtime:

- payload nhỏ có hard limit mới inline;
- file lớn luôn dùng private object reference/direct transfer;
- application server không proxy multi-GB bytes;
- multipart size/concurrency theo size, memory và provider bound;
- worker được admission theo disk/codec/GPU/region capability;
- output stream trực tiếp đến storage với checksum/backpressure;
- queue chỉ mang identity/reference, không mang file.

Adopter không viết planner config trên mỗi Task. `media`/`artifact` factory chọn
safe preset; chỉ data residency, hard workspace/GPU hoặc provider khác mặc định
mới cần override.

Mọi performance claim phải đo byte copy, peak RSS, throughput, egress và
completion p50/p95/p99 trên cùng workload baseline.

## P1 — Bounded Autopilot, không thêm config mặc định

Autopilot quan sát queue lag, service time, CPU/RSS, event-loop lag, disk,
provider `429`, retry rate và lease expiry. Envelope mặc định đến từ project
profile/preset, không bắt mỗi Task viết `min/max`.

Triển khai theo thứ tự:

```text
observe -> recommend -> simulate -> canary -> bounded-auto
```

Mọi recommendation có evidence, expected effect, guardrail và rollback.
Autopilot không được quyết định business outcome, retry một effect `uncertain`
hoặc thay đổi state machine. AI chỉ diễn giải deterministic evidence.

## P2 — Optional Control Plane, không nằm trên data path

Embedded mode tiếp tục là mặc định. Control Plane/sidecar chỉ được xây sau pilot
nhiều process/cluster và không được proxy file lớn:

```text
Application -> commands -> optional RhinoQ Control Plane -> runtimes/workers
Browser ---------------- direct object bytes ----------> storage
```

Kafka, RabbitMQ, NATS, Temporal, Kubernetes và Terraform là adapter/deployment
choice. Không đưa chúng thành core dependency hoặc bắt adopter vận hành thêm
process nếu chưa có yêu cầu thật.

## Developer Console chuẩn dành cho dev

Một App Shell thống nhất:

```text
Overview · Tasks · Queues · Workers · Schedules · Artifacts
Realtime · Incidents · Metrics · Plan · Settings
```

Ưu tiên theo tác dụng:

1. Task Explorer: virtual list, search, URL filter, saved view, keyboard và
   inspector; một click thấy state, progress và next action.
2. Causal Task Detail: nối Task, attempt, retry, effect, artifact, provider và
   verification thành timeline có evidence.
3. Plan Inspector: factory -> compiled capsule -> readiness -> `Needs decision`;
   chỉ export preview patch, không tạo config drift.
4. Incident Room: chuyện gì xảy ra, phạm vi nào bị ảnh hưởng, business outcome
   có biết không và hành động nào an toàn.
5. Realtime/Data inspector: latency breakdown, coalesced reads, byte path,
   workspace và slow consumer thay vì vanity KPI.
6. Proof view: code/config/process trước-sau và benchmark cùng workload.

Mỗi metric phải có unit, time range, denominator, data source và updated time.
Graphite/navy, một accent blue, semantic color chỉ cho state, monospace cho
identity/metric, selectable density, keyboard và accessibility là acceptance
criteria.

## Những thứ không đưa vào golden path

- workflow DSL tổng quát chỉ để cạnh tranh feature list;
- người dùng viết Execution Capsule hoặc intent object dài;
- source-code/LLM guessing để quyết định effect safety;
- Redis/WebSocket/Kubernetes bắt buộc cho ứng dụng nhỏ;
- proxy bytes qua Control Plane;
- UI âm thầm sửa production policy;
- auto-retry unknown external result;
- thêm adapter khi chưa có adopter và benchmark/support plan;
- claim nhanh hơn, exactly-once hoặc production-ready không có failure model và
  evidence.

## Bằng chứng bắt buộc

Xây ba reference adopter có baseline viết tay tương đương:

1. API Task thông thường;
2. video/file lớn;
3. batch fan-out có partial failure.

Mỗi report đo:

- consumer-owned LOC/config/process/dependency;
- time-to-first-green-run;
- queue-to-start và completion p50/p95/p99;
- throughput, peak RSS, DB read/write và bytes qua app server;
- crash recovery, duplicate dispatch, response loss và shutdown;
- phần nào synthetic, container integration hay production evidence.

Không tính generated files, dependency source, tests hoặc business handler là
code RhinoQ đã xóa.

## Thứ tự triển khai chuẩn

1. Reference adopters và net-complexity baseline trước khi thêm API mới.
2. Golden project profile, factory aliases và docs mặc định ngắn; giữ low-level
   API ở advanced/migration path.
3. Automatic realtime + browser multiplex/fallback + load evidence.
4. Progress coalescer và DB-write/fault evidence.
5. Processor packs độc lập và Data Path Planner cho large media.
6. Integration Eraser preview-only.
7. TaskEvidencePassport và causal Task Detail.
8. Plan Inspector và Developer Console shell.
9. Autopilot observe/recommend; chỉ canary sau benchmark.
10. Optional Control Plane sau design-partner multi-cluster pilot.

## Definition of Done cho mỗi slice

- Có before/after adopter code cùng behavior.
- Golden path ngắn hơn và negative code budget dương.
- Không thêm correctness logic vào Node SDK nếu thuộc Go engine.
- Public contract được version, type-check và test.
- Happy, failure, crash/restart, cancellation và bounded-resource path phù hợp
  đều có test.
- README/docs/example/changelog khớp behavior đã có.
- Performance claim có benchmark tái lập và raw evidence.
- Migration preview, rollback/recovery và known limitation được ghi rõ.
- Optional capability không kéo dependency/process không liên quan.

RhinoQ chỉ nhận tính năng mới khi nó xóa code/process, loại bỏ lỗi correctness,
giảm tài nguyên có đo hoặc hoàn thiện install-to-production path. “Trông hiện
đại” và “đối thủ có” không phải acceptance criterion.
