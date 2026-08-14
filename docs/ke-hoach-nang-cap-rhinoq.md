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

---

## Kế hoạch thực thi toàn diện sau audit — 2026-08-14

Phần này biến định hướng sản phẩm ở trên thành backlog có thể triển khai và
kiểm chứng. Đây là nguồn kế hoạch duy nhất cho đợt hardening sau `v0.1.0-beta.15`;
`docs/roadmap.md` tiếp tục mô tả release gates cấp cao, còn trạng thái bằng chứng
theo thời điểm nằm trong `docs/evidence/`.

Quy ước trạng thái:

- **Đã có:** code và test tương ứng đã tồn tại trong repository;
- **Một phần:** đã có bounded slice nhưng chưa khép kín production path;
- **Thiếu evidence:** capability đã có nhưng chưa đủ benchmark/adopter/fault
  evidence để đưa ra claim;
- **Chưa làm:** chưa có implementation đáp ứng acceptance criteria bên dưới;
- **Hoãn có chủ ý:** không làm trước khi dependency hoặc evidence gate được đạt.

### Quyết định sản phẩm hiện tại

RhinoQ hiện phù hợp cho **public beta và controlled pilot**. Chưa được gọi là
production-ready hoặc nhanh hơn nền tảng khác. Core correctness khá đầy đủ,
nhưng ba blocker quan trọng nhất vẫn là:

1. chưa có adopter thật chứng minh giảm tổng code/config/process/credential;
2. chưa có benchmark đi hết HTTP → PostgreSQL/Redis → worker → provider →
   artifact → realtime browser trên topology giống production;
3. chưa có browser acceptance và deployment-shaped fault campaign.

Không mở rộng thêm workflow DSL, queue adapter hoặc Control Plane trước khi ba
blocker trên có chuyển biến đo được.

### Baseline được phép dùng khi bắt đầu nâng cấp

Baseline này là regression evidence, không phải SLA:

| Khu vực | Bằng chứng hiện tại | Diễn giải đúng |
|---|---|---|
| CI/release | Go, Node 22/24, PostgreSQL integration, fan-out gate và security scan xanh tại commit `6b611a3` | release pipeline khỏe, không chứng minh production workload |
| Go Task progress | khoảng 75–99 ns/op, 0 allocation trong lần đo mới nhất | domain hot path nhanh trong process |
| Node snapshot | khoảng 3,18 triệu operation/giây trong process | không gồm HTTP, database, Redis hoặc handler |
| PostgreSQL tại concurrency 16 | khoảng 2.063 create/s và 3.991 read/s; create p99 khoảng 28,9 ms | baseline một máy/container, không phải capacity plan |
| PostgreSQL tại concurrency 32 | create giảm còn khoảng 1.601/s; create p99 khoảng 102 ms | đã thấy điểm bão hòa, không được tăng concurrency mù |
| Fan-out 1.000 | full Snapshot khoảng 212 KiB, p95 khoảng 61,6 ms; Summary khoảng 324 B, p95 khoảng 4,24 ms | Summary giải quyết polling; full Snapshot không phù hợp hot path |
| Execution page | direct indexed plan đọc 51 rows khoảng 0,106 ms, nhưng client-observed first page tăng tới khoảng 5,6–6,6 ms ở 5.000 executions trong remediation run | planner stats, prepare mode, driver/round-trip và heap access cần được đo tiếp |
| Artifact | live S3 multipart và restart resume đã có exact readback | chưa chứng minh browser responsiveness hoặc vượt native provider throughput |
| Failover | 150/150 acknowledged rows tồn tại sau một local primary kill/promotion | chưa có quorum, split-brain, multi-host hoặc sustained-load evidence |
| BullMQ/Redis | một local restart campaign hội tụ Task thành công | chưa có partition, retry storm hoặc production concurrency campaign |

Các raw artifact liên quan:

- `docs/evidence/benchmark-postgres-2026-08-01.json`;
- `docs/evidence/benchmark-remediation-2026-08-12.md`;
- `docs/evidence/artifact-production-lab-2026-08-13.md`;
- `docs/evidence/postgres-failover-2026-08-12.md`;
- `docs/evidence/redis-bullmq-chaos-2026-08-05.md`;
- `docs/evidence/low-code-upgrade-status-2026-08-14.md`.

Nếu hai campaign cho kết quả khác nhau, báo cáo phải giữ cả hai, ghi rõ hardware,
dataset, warm-up, PostgreSQL statistics và command; không chọn số đẹp hơn.

### Scorecard dùng để ra quyết định

Điểm dưới đây là đánh giá kỹ thuật tại thời điểm audit, không phải claim marketing:

| Hạng mục | Điểm tham chiếu | Việc làm thay đổi điểm |
|---|---:|---|
| Build/test/security | 9/10 | giữ release gates xanh và thêm dependency/license policy |
| Async correctness | 8,5/10 | thêm checkpoint có scope, multi-replica realtime và fault campaign |
| In-process performance | 8/10 | giữ regression budget hiện tại |
| Production performance evidence | 5/10 | hoàn thành deployment-shaped benchmark với saturation curve |
| Integration simplicity | 6,5/10 | golden path, package/API diet và adopter measurement |
| Bằng chứng giảm integration cost | 3,5/10 | ít nhất ba adopter before/after có raw diff |
| Differentiation | 7,5/10 về thiết kế | Evidence Passport v2, uncertainty recovery và adopter proof |
| Production readiness | 5/10 | đạt Pilot/RC gates ở cuối tài liệu |

Không cập nhật score bằng cảm nhận. Mỗi lần thay đổi điểm phải liên kết tới test,
benchmark, adopter report hoặc release artifact mới.

## Mục tiêu đầu ra và metric bắt buộc

### Outcome O1 — Tích hợp ngắn hơn thật sự

Đo trên ít nhất ba ứng dụng đại diện:

1. Task API thông thường;
2. batch fan-out có partial failure;
3. file/media hoặc external effect có confirmation.

Mỗi ứng dụng phải có commit `before` và `after` cố định. Báo cáo tối thiểu:

| Metric | Cách tính | Target để claim “giảm đáng kể” |
|---|---|---|
| Handler rewrite | diff trong business handler | 0 rewrite bắt buộc |
| Net integration LOC | RhinoQ-related LOC thêm trừ lifecycle/status/polling/recovery LOC xóa | âm ở ít nhất 2/3 adopter; adopter còn lại phải có lý do correctness rõ ràng |
| Process | process/service mới trừ process bị bỏ | không thêm process bắt buộc cho embedded path |
| Datastore | datastore mới bắt buộc | 0 ngoài PostgreSQL đã khai báo cho embedded path |
| Credential class | loại credential mới để vận hành RhinoQ | không thêm Gateway credential khi không dùng Gateway |
| Time to first green | từ clone/branch đến Task chạy và xuất hiện trong Task Center | median không quá 15 phút trong no-coaching pilot |
| Time to diagnose | từ fixture failure tới operator xác định outcome và safe next action | giảm ít nhất 30% so với baseline cùng fixture |

Generated source, dependency code, test fixture và business handler không được
tính như code RhinoQ đã xóa. Report phải xuất JSON máy đọc được và Markdown cho
người review.

### Outcome O2 — Nhanh và bounded trên đường dùng thật

Không dùng một throughput number duy nhất. Mỗi benchmark phải tìm saturation
point và tail latency. Các gate đầu tiên:

- Task Summary p95 không tăng quá 20% từ fan-out 100 tới 5.000 trên cùng
  topology sau warm-up;
- page 50 Executions p95 không tăng quá 1,5 lần từ fan-out 100 tới 5.000;
- không endpoint browser mặc định nào materialize toàn bộ Execution history;
- không regression quá 10% so với accepted baseline nếu code/SQL không có
  explanation và approval;
- benchmark ghi pool size, concurrency, CPU/RAM, storage, PostgreSQL config,
  dataset, payload distribution, handler duration và warm-up;
- capacity recommendation luôn có safety margin và workload assumptions.

Các ngưỡng này là release gate của RhinoQ, không phải SLA cho adopter. SLA chỉ
được công bố sau khi adopter chạy cùng harness trên topology của họ.

### Outcome O3 — Realtime hội tụ và không trở thành nguồn truth thứ hai

- mọi frame mang `entityVersion` và client từ chối stale state;
- mất signal, reconnect hoặc đổi replica vẫn hội tụ về PostgreSQL snapshot;
- cùng một Task/owner/tenant chỉ có một read đang chạy trong mỗi process;
- slow consumer bị bound hoặc disconnect, không tăng memory vô hạn;
- mutation-to-visible latency có p50/p95/p99 và tỷ lệ polling fallback;
- signal bus chỉ mang identity/version, không mang canonical snapshot.

### Outcome O4 — External effect không bị retry mù

- mọi effect nguy hiểm có stable identity, request fingerprint và confirmation
  policy;
- response loss chuyển `uncertain`;
- reconciler chỉ được gọi verifier/readback, không nhận mutation callback;
- retry chỉ được mở khi có bằng chứng `not_happened`;
- Evidence Passport ghi rõ trạng thái technical, external và business riêng.

### Outcome O5 — Người mới hiểu sản phẩm mà không đọc toàn repository

- một quickstart canonical;
- một package canonical;
- một API golden path;
- một status ledger tự sinh;
- tài liệu beginner không buộc đọc API advanced;
- mọi command trong quickstart được chạy trong release smoke.

## Thang bằng chứng và quy tắc claim

| Level | Bằng chứng | Được phép nói |
|---|---|---|
| L0 | unit/in-process benchmark | implementation hoạt động, hot path không regression |
| L1 | real PostgreSQL/Redis/provider trong container hoặc sandbox | component path đã được kiểm chứng trong môi trường ghi rõ |
| L2 | multi-process deployment-shaped campaign có load/fault | capacity/recovery cho đúng topology và workload đó |
| L3 | adopter production/pilot có before/after và SLO | product/integration claim trong phạm vi workload đã đo |

Không nâng claim từ L0/L1 lên production. Mọi dashboard, README và release note
phải liên kết evidence level tương ứng.

## P0 — Chứng minh giá trị và thu gọn golden path

### P0-01 — Adoption Scorecard và reference adopters

**Trạng thái:** thiếu evidence.

**Vấn đề:** fixture hiện tại chứng minh contract nhưng chưa chứng minh người dùng
thật xóa được nhiều plumbing hơn phần họ phải thêm. Probe lịch sử từng xóa 535
lifecycle lines nhưng thêm 997 lines, một Gateway process và ba credential
classes; embedded profile được tạo để sửa vấn đề này nhưng chưa được đo lại
trên cùng workload.

**Thiết kế:**

1. mở rộng `rhinoq measure` để nhận hai git ref hoặc hai thư mục;
2. phân loại file thành business, integration, generated, tests và config;
3. đếm route, process, datastore, credential class, dependency và runbook;
4. sinh manifest behavior để xác nhận `before` và `after` thực sự tương đương;
5. chạy no-coaching pilot, ghi timestamp của từng bước;
6. lưu raw JSON, Markdown summary và commit SHA dưới `docs/evidence/`;
7. yêu cầu reviewer ngoài người implement ký verdict `GO`, `CONDITIONAL` hoặc
   `NO-GO`.

**Test bắt buộc:** fixture chống gian lận LOC; rename detection; generated-file
exclusion; monorepo path filter; Windows/Linux path parity; report deterministic.

**Acceptance criteria:**

- ba adopter hoàn thành cùng protocol;
- không adopter nào phải viết lại business handler để phù hợp RhinoQ;
- ít nhất hai adopter có net integration LOC âm;
- embedded path không thêm process hoặc Gateway credential;
- mọi con số truy ngược được tới file/line và git ref;
- README chỉ được claim savings đúng trong phạm vi kết quả thu được.

**Rollback:** command mới là read-only; nếu classifier không đủ tin cậy, hạ kết
quả về inventory và không tính savings.

### P0-02 — Golden path, API diet và package diet

**Trạng thái:** một phần.

**Vấn đề:** `defineRhinoQProject()` và short factories đã có, nhưng root Node
entry hiện re-export khoảng 81 nhóm symbol; package dry-run khoảng 622 KiB nén,
3,29 MiB giải nén và 482 files. API vẫn mạnh nhưng người mới khó biết đâu là
đường mặc định.

**Thiết kế:**

- giữ backward compatibility trong beta, nhưng tài liệu root chỉ giới thiệu
  tối đa 10–15 symbol golden path;
- chuẩn hóa subpath: `/core`, `/server`, `/browser`, `/react`, `/nest`, `/bullmq`,
  `/sqs`, `/verified`, `/admin`;
- không để browser subpath kéo `pg`, Nest, worker lifecycle hoặc provider SDK;
- chuyển internal helper khỏi public barrel nếu chưa được contract hóa;
- thêm API report phân nhóm stable/beta/advanced/internal;
- thêm package-content budget vào CI và giải thích mọi tăng trưởng;
- cân nhắc bỏ source map khỏi production tarball hoặc phát hành debug artifact
  riêng; không làm giảm khả năng debug mà không ghi release note;
- thống nhất docs dùng `@rhinoq/node/nest`; package `@rhinoq/nest` checkout-only
  chỉ còn migration note;
- release smoke kiểm tra ESM, CommonJS và từng subpath bằng tarball vừa build.

**Target kỹ thuật:**

- browser dependency graph không chứa database/framework/provider server code;
- unpacked tarball giảm ít nhất 30% so với baseline nếu không mất public
  capability; nếu không đạt, report phải chỉ ra file nào bắt buộc;
- root documentation không yêu cầu người mới chọn giữa nhiều factory tương
  đương;
- import advanced không xuất hiện trong quickstart đầu tiên;
- API snapshot fail CI khi export mới không có stability tag và docs owner.

**Test:** package pack smoke với cache tạm; tree-shaking fixture; ESM/CJS/subpath
matrix; TypeScript inference; browser bundler smoke; install từ registry/tarball.

**Rollback:** thêm compatibility re-export trong một release deprecation window;
không xóa public beta API trong cùng change với package diet.

### P0-03 — Capability/status ledger tự sinh

**Trạng thái:** chưa làm đầy đủ.

**Vấn đề:** `.ai/STATUS.md`, `.ai/PROJECT_CONTEXT.md`, README và roadmap có thể
lệch nhau. Tài liệu cũ từng nói chưa có tagged release hoặc một số capability
chưa hoàn thiện dù release mới đã chứa chúng.

**Thiết kế:** tạo một manifest versioned chứa:

```text
capability id
public surface
status: implemented | tested | evidence-limited | deferred
test/evidence links
runtime/profile support
release first available
known limitations
owner
```

Generator tạo bảng cho README/status/roadmap nhưng không tự ghi marketing prose.
CI so sánh generated output, release workflow xác nhận version/tag/package và
không cho status `implemented` nếu test/evidence link không tồn tại.

**Acceptance criteria:**

- một capability không cần sửa tay ở ba bảng khác nhau;
- release tag, npm dist-tag và README version được kiểm tra cùng nhau;
- link checker phát hiện evidence path chết;
- status `production-ready` không tồn tại nếu Pilot/RC gates chưa đạt;
- generated diff ổn định trên Windows/Linux.

**Rollback:** generator chỉ quản lý block có marker; prose ngoài block không bị
ghi đè.

### P0-04 — Browser acceptance harness

**Trạng thái:** thiếu evidence.

**Phạm vi:** dùng Playwright trên reference adopter đã build từ tarball, không
import source checkout.

**Scenario bắt buộc:**

1. login bằng hai owner và hai tenant, không đọc chéo được;
2. hai tab theo dõi cùng Task, một tab cancel hoặc retry;
3. SSE mất kết nối, polling fallback, SSE trở lại và state không lùi;
4. event cũ tới sau snapshot mới;
5. cancel đồng thời với worker finish;
6. 1.000 Task trong inbox và 5.000 Execution trong detail;
7. waitpoint duplicate resolution và conflicting payload;
8. result/artifact expired rồi refresh qua authorized resolver;
9. WebSocket slow consumer và subscription limit;
10. multipart resume, tab reload và checksum chạy trong Web Worker.

**Đo:** long tasks trên main thread, INP/LCP của fixture, mutation-to-visible
latency, connection count, fallback duration, heap growth và request count.

**Acceptance criteria:** không stale render; không tenant leak; không unbounded
DOM/history; main-thread hashing không tạo long task lặp lại; keyboard và
screen-reader labels cho action/state chính; screenshot và trace được lưu khi
fail.

### P0-05 — Deployment-shaped benchmark và SLO worksheet

**Trạng thái:** chưa làm.

**Topology tối thiểu:**

```text
load generator
  -> owner HTTP API (>=2 replicas)
  -> PostgreSQL 16 with constrained pool
  -> Redis/BullMQ when selected
  -> >=2 workers with registered handlers
  -> provider sandbox/object storage
  -> SSE/WebSocket browser probes
```

Native PostgreSQL queue và BullMQ là hai campaign riêng; không trộn kết quả.

**Workload matrix:**

| Scenario | Dataset | Fault |
|---|---|---|
| single Task | small payload, short/medium/long handler mix | worker SIGKILL |
| fan-out | 100/1.000/5.000 items, partial failure | Redis restart hoặc DB connection loss |
| external effect | accepted, timeout, lost response, readback | provider latency/429/5xx |
| artifact | 16 MiB/256 MiB/multi-GB planned path | upload interruption/resume |
| realtime | 1/10/100 subscriptions per client | replica restart/missed invalidation |
| recurring | burst of due schedules | scheduler takeover |

**Metric:** enqueue/claim/start/complete p50/p95/p99; queue lag; DB pool wait;
locks; WAL; rows/bytes; event-loop lag; CPU/RSS; worker utilization; provider
rate; reconnect/fallback; stale reject count; backlog recovery time.

**Output:** raw time series, environment manifest, saturation graph, safe
concurrency recommendation và SLO worksheet. Harness phải chạy local nhỏ và CI
scheduled; full campaign không chặn mọi PR nhưng chặn RC.

**Acceptance criteria:** xác định saturation point thay vì chỉ peak throughput;
recovery trở về steady state; không acknowledged Task biến mất; stale worker
không ghi được sau mất lease; mọi claim liên kết raw artifact.

## P1 — Tối ưu hot path và scale có kiểm soát

### P1-01 — Summary-first và Execution paging ổn định

**Trạng thái:** Summary đã có; paging cần hardening.

**Thiết kế:**

- owner UI và realtime chỉ đọc Summary theo mặc định;
- full Snapshot chuyển thành compatibility/diagnostic API có hard limit và
  warning telemetry;
- giữ keyset `(created_at,id)`, không dùng offset;
- benchmark prepared statement custom/generic plan và pgx simple/extended mode;
- kiểm tra `ANALYZE` sau bulk fixture/import; doctor cảnh báo stale statistics;
- xem xét covering index `INCLUDE` chỉ sau `BUFFERS` chứng minh heap fetch là
  bottleneck;
- giới hạn page size, selected columns và serialized bytes;
- cân nhắc read model chỉ khi index/query tuning không đạt gate.

**Test:** 100/1.000/5.000/100.000 executions; concurrent append giữa hai page;
same timestamp tie; stale stats; cold/warm cache; RLS role; migration upgrade.

**Acceptance criteria:** page 50 không quét/sort toàn Task; result order ổn định;
p95 growth gate đạt; full Snapshot không xuất hiện trong browser polling trace.

**Rollback:** giữ compatibility endpoint và index additive; feature flag cho
read model nếu được thêm.

### P1-02 — Adaptive admission và backpressure một nút

**Trạng thái:** admission/rate/resource metadata đã có; controller thích nghi
chưa được quyền áp dụng.

**Tín hiệu đầu vào:** queue lag, DB pool wait, claim latency, worker service
time, CPU/RSS, event-loop lag, disk workspace, provider 429/timeout và lease
expiry.

**Thuật toán đầu tiên:** AIMD hoặc gradient controller có:

- `min`, `max` và absolute safety cap từ runtime profile;
- hysteresis để tránh dao động;
- cooldown và minimum sample count;
- per-tenant weighted budget;
- resource-class lane cho CPU, IO, GPU và provider-bound work;
- giảm nhanh khi 429/pool wait/lease expiry tăng, tăng chậm khi ổn định.

Controller chỉ tạo recommendation và simulation trước. Runtime Go tiếp tục sở
hữu admission/concurrency; Node không tự quyết định lease hoặc retry.

**Acceptance criteria trước canary:** deterministic trên recorded trace; không
vượt cap; không starvation tenant; rollback về static config trong một command;
recommendation giải thích signal, expected impact và confidence.

**Acceptance criteria trước bounded-auto:** canary trên design partner; SLO tốt
hơn static baseline; không tăng uncertain/retry storm; audit đầy đủ mọi thay đổi.

### P1-03 — Realtime multi-replica không thêm broker bắt buộc

**Trạng thái:** in-process invalidation đã có; external replica signal còn thiếu.

**Thiết kế mặc định:** transactional outbox hoặc commit-adjacent signal gửi
`tenantId`, `ownerId`, `taskId`, `entityVersion`; PostgreSQL `LISTEN/NOTIFY` là
adapter đầu tiên vì PostgreSQL đã bắt buộc. Hub coalesce signal, đọc một
authoritative Summary và fan-out frame đã serialize.

Redis/NATS chỉ là adapter tùy chọn khi benchmark chứng minh PostgreSQL signal là
bottleneck. Polling luôn còn để chữa missed signal.

**Failure semantics:**

- notify mất: polling hội tụ;
- notify trùng: version dedup;
- notify tới sai thứ tự: version floor;
- replica chết sau commit trước notify: outbox/sweep phát lại;
- slow consumer: bounded queue rồi disconnect với reason;
- auth/tenant đổi: subscription bị revalidate hoặc đóng.

**Acceptance criteria:** hai API replica nhận mutation từ replica khác; không
canonical state trong broker; coalesced read ratio được đo; memory không tăng
theo số frame chờ vô hạn; zero-config SSE vẫn hoạt động khi adapter tắt.

### P1-04 — Data-path compiler và browser hashing

**Trạng thái:** bounded transport/multipart/workspace có; browser performance
và provider breadth còn thiếu.

**Thiết kế:**

- compile inline/reference/direct-multipart từ file size, provider limits và
  declared resource constraints;
- queue chỉ mang immutable reference + checksum metadata;
- SHA-256 chạy Web Worker; cân nhắc WASM sau benchmark, không mặc định vì tên
  công nghệ;
- pipeline đọc chunk một lần để hash và upload chồng lấp có backpressure;
- direct-to-provider, không proxy large bytes qua API hoặc Control Plane;
- worker workspace có quota, lease, cleanup và startup orphan sweep;
- data locality/GPU/codec là admission facts, không phải business state;
- completion response mất chuyển `uncertain`, sau đó HEAD/list-parts/readback.

**Benchmark:** bytes qua app server; peak browser/worker RSS; main-thread long
task; throughput; egress; multipart retries; checksum CPU; provider cost proxy.

**Acceptance criteria:** browser UI vẫn tương tác trong 256 MiB fixture;
multi-GB path không materialize toàn file trong Node Buffer; resume không upload
lại part provider đã xác nhận; checksum/readback bắt buộc trước attachment.

### P1-05 — Evidence Passport v2 / Outcome Capsule

**Trạng thái:** passport read-only v1 đã có.

**Bổ sung contract:**

- Task definition và schema version;
- handler build/version/digest;
- runtime adapter và worker build version;
- verifier name/version và verification policy;
- provider operation identity, request fingerprint và confirmation source;
- artifact checksum, lineage, retention class và readback timestamp;
- recovery command/approval/precondition/post-check;
- evidence completeness và reason khi thiếu;
- bounded trace/incident references, không nhúng raw log.

Ba câu trả lời vẫn độc lập:

```text
technical execution succeeded?
external effect confirmed?
business outcome achieved?
```

**Thiết kế lưu trữ:** facts append-only; projection có schema version; owner view
redact operator/provider identity; operator export có scope và audit. Chữ ký/WORM
export là capability tùy chọn sau khi threat model và key rotation rõ ràng.

**Acceptance criteria:** replay cùng evidence tạo cùng projection; missing
verifier không thành `achieved`; version mismatch hiển thị; export bounded và
không chứa secret/private storage reference.

### P1-06 — Confirmation adapters và Uncertainty-first Recovery

**Trạng thái:** generic primitives có; provider-ready experience còn thiếu.

**Adapter ưu tiên:** HTTP mutation, Stripe-shaped payment, S3-compatible object,
webhook callback và provisioning resource.

Mỗi adapter phải khai báo:

- idempotency scope và provider enforcement;
- request fingerprint;
- accepted/confirmed/not-happened/unknown mapping;
- readback API và webhook identity;
- rate/error classification;
- safe retry condition;
- redaction và evidence retention;
- sandbox/fault fixture.

**Không được làm:** adapter gọi lại mutation trong reconciliation; coi 404 luôn
là `not_happened`; coi timeout là failure; claim exactly-once chỉ vì có ledger.

**Acceptance criteria:** lost response không tạo effect thứ hai; webhook/readback
race hội tụ; duplicate webhook idempotent; permission denied vẫn `unknown`;
operator thấy lý do và safe next action.

### P1-07 — Integration Eraser v2 có proof graph

**Trạng thái:** scanner/diff/reverse-patch preview đã có; apply vẫn hoãn có chủ ý.

**Thiết kế tiếp theo:**

- AST-aware detector cho Express/Nest/Next, BullMQ listeners, polling hooks,
  upload proxy và retry timer;
- graph nối route → client hook → runtime event → storage dependency;
- mỗi candidate có confidence, behavior thay thế, auth boundary và evidence;
- tạo patch trong disposable git worktree;
- install/typecheck/test/build adopter bằng command khai báo;
- sinh reverse patch và file-by-file review checklist;
- chỉ xuất patch artifact; người dùng tự apply sau review.

**Acceptance criteria:** không chạm business handler/auth/verification; patch
không được tính savings nếu build/test chưa chạy; low-confidence không tự chọn;
working tree chính không bị mutation; Windows/Linux path parity.

### P1-08 — Resumable checkpoints có scope hẹp

**Trạng thái:** selective checkpoint contract v1 đã có qua Node port/PostgreSQL
schema v12; worker/runtime adoption và adopter fault evidence còn thiếu.

Không xây workflow engine tổng quát. Chỉ thêm checkpoint khi workload lớn có
đơn vị công việc deterministic và artifact trung gian có checksum, ví dụ media
segment, archive chunk hoặc import page.

**Contract cần có:** checkpoint key/version; handler build; input checksum;
completed unit set hoặc cursor; artifact refs; resume compatibility; cleanup;
max checkpoints; invalidation reason.

**Correctness:** Go/Application quyết định checkpoint hợp lệ; worker SDK chỉ
ghi/đọc qua port. Handler version hoặc input checksum đổi thì fail closed hoặc
bắt đầu execution mới, không resume mù.

**Acceptance criteria:** SIGKILL giữa workload không lặp completed external
effect; checkpoint bounded; incompatible build không resume; cleanup có preview
và retention policy.

### P1-09 — Tenant/RBAC và operator security

**Trạng thái:** owner/tenant filtering và full-profile RLS một phần; tenant-wide
RBAC chưa hoàn chỉnh.

**Thiết kế:**

- principal contract gồm tenant, subject, role, credential ID và auth method;
- role tối thiểu: owner, support-read, operator, approver, admin;
- action matrix cho read, cancel, retry, approve, repair, artifact refresh,
  schedule control và evidence export;
- Go Gateway và embedded Node surface dùng cùng authorization fixtures;
- PostgreSQL role không superuser, RLS forced và doctor kiểm tra;
- operator token có rotation/expiry/audit; production remote path cần TLS và
  network policy;
- list/history/export luôn bounded và redact payload/secret.

**Test:** cross-tenant matrix; confused deputy; stale role; token rotation;
two-person repair; direct endpoint gọi dù UI ẩn; RLS after failover/restore.

**Acceptance criteria:** deny-by-default; UI capability không phải security
boundary; mọi mutation có actor/reason/command identity; auth failure không rò
internal object existence.

### P1-10 — Retention, partition, backup và fault hardening

**Trạng thái:** bounded prune và local drills có; production operations thiếu.

**Việc cần làm:**

- table growth model theo Tasks/day, executions/task, evidence/task;
- retention class cho hot state, evidence, artifact metadata và audit;
- partition proposal chỉ khi benchmark chứng minh vacuum/index/storage pain;
- online partition migration/rollback rehearsal;
- backup + point-in-time restore drill, sau restore chạy checksum/RLS/doctor;
- multi-host PostgreSQL failover có witness/fencing nếu claim HA;
- split-brain scenario và stale primary write refusal;
- Redis partition/restart dưới load, worker crash, retry storm, disk full,
  provider 429/timeout và clock skew;
- runbook cho backlog drain, poison isolation và evidence export.

**Acceptance criteria:** RPO/RTO được adopter chọn và drill chứng minh; open
Finding/pending delivery/ProviderOperation không bị prune; restore không vô hiệu
RLS; fault campaign lưu timeline và acknowledged-work verdict.

## P2 — Lợi thế sản phẩm sau khi P0/P1 có evidence

### P2-01 — One-knob bounded Autopilot

**Trạng thái:** observe/recommend/simulate và bounded executor có approval,
health gate và rollback; bounded-auto vẫn bị cấm với correctness/task state.

Input người dùng chỉ nên là SLO, budget/cost cap và hard safety bounds. Output
là một recommendation tại một thời điểm, gồm evidence, expected effect,
confidence, blast radius, canary plan và rollback.

Thứ tự bắt buộc:

```text
observe -> recommend -> replay simulation -> shadow -> canary -> bounded-auto
```

Autopilot không được thay business outcome, effect confirmation, retry
`uncertain`, tenant authorization hoặc state-machine semantics. AI chỉ được
paraphrase deterministic plan.

Gate chuyển sang bounded-auto:

- ít nhất một design partner chạy canary;
- recommendation deterministic trên cùng evidence;
- canary có stop condition tự động;
- rollback đã diễn tập;
- audit ghi old/new config, actor, reason và observed effect;
- không làm xấu SLO/cost/error budget so với static baseline.

### P2-02 — Processor packs có support boundary thật

**Trạng thái:** generic lifecycle, FFmpeg và Sharp provider-injected boundary
có; package/version/fault evidence của adopter và LibreOffice, malware, AI pack
vẫn còn demand-gated.

Mỗi pack là package tùy chọn và phải có:

- exact runtime/version support matrix;
- readiness và capability probe;
- resource estimate/admission facts;
- cancellation/timeout/kill behavior;
- workspace quota và orphan cleanup;
- deterministic error classification;
- artifact/output validation;
- container example chạy non-root;
- fault and resource benchmark;
- support/upgrade/rollback policy.

Không gom nhiều binary/provider vào core image. AI pack không quyết định business
correctness và không che model/provider error thành retry-safe.

### P2-03 — Optional Control Plane

**Trạng thái:** hoãn có chủ ý.

Chỉ bắt đầu ADR/implementation khi có pilot nhiều process/cluster chứng minh:

- embedded/operator queries gây bottleneck thật;
- cần fleet-wide policy, history read model hoặc remote operation;
- auth/RBAC và tenant model đã ổn định;
- large bytes vẫn đi trực tiếp storage;
- có owner vận hành, SLO, upgrade và rollback plan.

Control Plane không được trở thành data proxy, queue truth hoặc correctness
engine thứ hai. Go authoritative state và PostgreSQL fencing vẫn giữ nguyên.

## Khác biệt cạnh tranh phải xây và phải chứng minh

Không tuyên bố đối thủ “không làm được”. Temporal/Hatchet mạnh về durable
workflow; Inngest/Trigger.dev mạnh về hosted onboarding, flow control và
realtime; BullMQ mạnh về queue primitives và ecosystem. RhinoQ nên tập trung
vào tổ hợp khó hơn để retrofit:

1. giữ existing producer/worker/business handler;
2. thêm owner-facing Task contract và UI mà không migrate runtime;
3. tách technical completion, external confirmation và business outcome;
4. fail closed thành `uncertain` khi provider result không biết;
5. tạo Evidence Passport và safe recovery từ evidence;
6. đo rồi xóa integration glue bằng Adoption Scorecard/Integration Eraser.

Tổ hợp này chỉ trở thành lợi thế khi ba adopter và L2 fault/performance campaign
đạt gate. Trước đó chỉ được gọi là product hypothesis có implementation.

Nguồn chính thức dùng để review ranh giới cạnh tranh, kiểm tra lại trước khi
viết comparison hoặc release claim:

- Temporal: [Workflow Definition](https://docs.temporal.io/workflow-definition)
  và [Activities](https://docs.temporal.io/activities);
- Inngest: [Functions](https://www.inngest.com/docs/learn/inngest-functions),
  [Concurrency](https://www.inngest.com/docs/functions/concurrency) và
  [Realtime](https://www.inngest.com/docs/features/realtime);
- Trigger.dev: [Tasks](https://trigger.dev/docs/writing-tasks-introduction) và
  [Queue concurrency](https://trigger.dev/docs/queue-concurrency);
- BullMQ: [Job Schedulers](https://docs.bullmq.io/guide/job-schedulers),
  [Deduplication](https://docs.bullmq.io/guide/jobs/deduplication),
  [Flows](https://docs.bullmq.io/guide/flows) và
  [Retries](https://docs.bullmq.io/guide/retrying-failing-jobs);
- Hatchet: [documentation](https://docs.hatchet.run/v1).

Comparison phải ghi ngày review, phiên bản nếu nguồn cung cấp, và phân biệt
hosted experience với self-hosted/core capability.

## Thứ không làm trong chu kỳ này

- generic DAG/workflow language;
- thêm Python/Java/.NET SDK trước adoption evidence;
- thêm queue adapter chỉ để đủ feature matrix;
- bắt Redis/NATS/Kubernetes/Control Plane trong golden path;
- proxy artifact bytes qua RhinoQ service;
- tự apply Integration Eraser lên nhánh chính;
- tự retry external result `uncertain`;
- Autopilot tự sửa business/correctness policy;
- provider marketplace;
- claim exactly-once, production-ready hoặc nhanh hơn đối thủ không cùng failure
  model và workload.

## Risk register và điều kiện dừng

| Rủi ro | Dấu hiệu sớm | Giảm thiểu | Điều kiện dừng/rollback |
|---|---|---|---|
| API diet phá adopter beta | tarball consumer hoặc typecheck fixture fail | compatibility re-export và deprecation window | giữ export cũ, chỉ thay docs golden path |
| Benchmark tối ưu sai workload | microbenchmark tốt nhưng E2E xấu | L0–L3 evidence ladder và adopter-shaped dataset | revert optimization nếu p95/p99 hoặc recovery xấu hơn budget |
| Adaptive controller dao động | concurrency/lag thay đổi liên tục | hysteresis, cooldown, min samples, static fallback | tắt canary, quay về profile tĩnh |
| Realtime làm tăng DB load | read/task hoặc pool wait tăng theo connection | coalesce, version floor, summary-only, poll budget | tắt signal adapter; polling vẫn là safety net |
| Checkpoint phình dữ liệu | checkpoint rows/bytes tăng không bound | max count, compaction, retention và artifact refs | vô hiệu resume cho handler/version đó |
| Provider adapter retry sai | duplicate external effect hoặc unknown bị gắn failure | readback-only reconciler và fault sandbox | disable retry path, giữ `uncertain` |
| Integration Eraser xóa nhầm | behavior manifest/build/test khác | disposable worktree, proof graph, human review | không phát patch hoặc chỉ xuất inventory |
| RBAC lệch giữa Go/Node | cùng principal cho kết quả khác | shared authorization fixtures | deny action và chặn Pilot gate |
| Evidence chứa secret | export có token/payload/private ref | schema allowlist, redaction tests | disable export và rotate affected credential |
| Docs/status drift | release/package/status không khớp | generated capability ledger | chặn release cho tới khi ledger sạch |
| Control Plane tăng vận hành | thêm process nhưng không giảm bottleneck | pilot gate và measured ownership cost | tiếp tục embedded mode, hoãn ADR |

Mỗi incident chạm correctness, tenant isolation hoặc duplicate external effect
phải dừng promotion release cho tới khi có regression test và recovery note.

## Trình tự triển khai và dependency

### Phase A — Evidence foundation, 2–3 tuần mục tiêu

1. P0-01 Adoption Scorecard.
2. P0-03 capability/status ledger.
3. P0-02 API/package baseline và budgets.
4. P0-04 browser harness skeleton.
5. P0-05 deployment harness skeleton.

Kết thúc Phase A phải có baseline tái lập; chưa cần claim thắng.

### Phase B — Hot-path hardening, 3–5 tuần mục tiêu

1. P1-01 Summary/paging.
2. P1-03 multi-replica realtime.
3. P1-04 browser/data path.
4. hoàn thành P0-04 và P0-05 campaign đầu tiên.
5. package/API diet không phá compatibility.

Kết thúc Phase B phải có saturation curve, browser trace và fault timeline.

### Phase C — Proof and recovery moat, 4–6 tuần mục tiêu

1. P1-05 Evidence Passport v2.
2. P1-06 confirmation adapters.
3. P1-07 Integration Eraser proof graph.
4. P1-09 RBAC.
5. P1-10 restore/fault hardening.

Kết thúc Phase C phải có một adopter external-effect hero flow và independent
review của lost-response recovery.

### Phase D — Pilot optimization, chỉ sau evidence

1. P1-02 adaptive recommendation/canary.
2. P1-08 selective checkpoints nếu adopter cần.
3. P2-01 bounded Autopilot canary.
4. P2-02 processor packs theo provider demand.
5. đánh giá lại P2-03, không tự động bắt đầu Control Plane.

Duration là planning target, không phải release promise. Nếu Phase A không tạo
được adopter/evidence, dừng mở rộng surface và sửa onboarding trước.

## Ownership và review bắt buộc

| Workstream | Owner chính | Reviewer bắt buộc |
|---|---|---|
| Adoption/golden path/docs | Product + Node SDK/DX | người chạy no-coaching pilot, không phải tác giả feature |
| Database/read path/retention | Go Application + PostgreSQL adapter | performance/database reviewer |
| Runtime/admission/checkpoint | Go Runtime | architecture + fault-test reviewer |
| Realtime/browser | Node server/browser surfaces | tenant/security + browser performance reviewer |
| Provider/evidence/recovery | Go Application + provider adapters | correctness/security reviewer |
| Packaging/release | SDK + release engineering | supply-chain reviewer |
| RBAC/Gateway | interfaces/infrastructure | security reviewer |
| Autopilot/Control Plane | architecture/product | maintainer approval sau adopter evidence |

Một work package không có owner, reviewer và rollback không được chuyển sang
`in progress`.

## Release gates

### Gate Beta hardening

- CI/security/release smoke xanh;
- status ledger không drift;
- Summary-first browser path;
- package/API budgets được ghi và chặn regression;
- browser reconnect/stale/cancel-race pass;
- không blocker security mức cao chưa có mitigation.

### Gate Controlled Pilot

- ít nhất một adopter before/after pass;
- deployment-shaped benchmark trên topology pilot;
- restore và worker-loss drill;
- tenant/RBAC matrix pass;
- operator runbook, retention và backup owner rõ;
- known limitations được adopter xác nhận.

### Gate Release Candidate

- ba adopter reports, ít nhất hai net-negative integration LOC;
- L2 campaign cho native PostgreSQL path và runtime adapter được support;
- external-effect lost-response/readback campaign pass;
- browser large-data/realtime campaign pass;
- migration expand/migrate/contract và rollback rehearsal;
- package provenance, SBOM, checksum, image và registry smoke xanh.

### Gate Production-ready/GA

- ít nhất một L3 pilot đủ thời gian quan sát theo SLO của adopter;
- error budget, saturation point và safety margin được ghi;
- RPO/RTO restore/failover được chứng minh trên topology mục tiêu;
- support/upgrade/security response ownership rõ;
- không claim nào vượt evidence level;
- maintainer ký production readiness review riêng.

## Template issue bắt buộc cho từng work package

```text
ID / title:
User problem:
Current evidence:
Scope:
Non-goals:
Architecture owner/layer:
Public contract change:
Migration/recovery:
Security/tenant impact:
Telemetry:
Unit/contract/integration/fault/benchmark/browser tests:
Before/after adopter artifact:
Acceptance criteria:
Rollback:
README/changelog impact:
Evidence level reached:
```

## Definition of Done toàn chương trình

Chương trình chỉ hoàn thành khi:

- golden path không yêu cầu viết lại business handler;
- ba adopter có raw before/after artifact và verdict độc lập;
- hai trong ba adopter giảm net integration LOC;
- embedded path không thêm process/datastore/credential không cần thiết;
- browser và deployment-shaped campaign tái lập được;
- Summary/paging/realtime giữ bounded behavior tại fan-out mục tiêu;
- mọi external effect nguy hiểm fail closed và có confirmation path;
- Evidence Passport phân biệt technical/external/business truth;
- tenant/RBAC, restore, retention và fault gates đạt cho topology hỗ trợ;
- public docs, generated status, examples, changelog và release artifact khớp;
- mọi performance/reliability/cost claim liên kết raw evidence và giới hạn;
- worktree không chứa secret, debug artifact hoặc generated drift;
- README chỉ được cập nhật để phản ánh behavior đã có, không quảng bá backlog.

Nếu một mục tạo thêm nhiều code/config/process hơn phần nó xóa, không tăng
correctness có thể chứng minh và không cải thiện metric đã chọn, mục đó phải bị
loại khỏi golden path dù implementation đã hoàn thành.
