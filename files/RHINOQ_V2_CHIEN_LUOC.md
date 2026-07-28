# RhinoQ v2 — Chiến lược, khác biệt, và đường tới người dùng thật

> Tài liệu này **thay thế** các mục 6, 51, 55, 56, 57, 59, 60, 61, 62 của `RHINOQ.md`.
> Toàn bộ phần kỹ thuật (mục 8–50) **giữ nguyên** — xem mục 12 để biết chính xác phần nào sống, phần nào chết.
> Nó cũng thay thế `RHINOQ_NANG_CAP.md` (bản đề xuất bỏ hẳn queue layer — bản đó sai, xem mục 2.3).
>
> **Review 2026-07-28:** bốn lớp COMMIT · RUN · VERIFY · RECOVER đều là sản
> phẩm; RECOVER chỉ là cửa vào dễ demo. Các claim tuyệt đối phía dưới về đối thủ
> được thay bằng giả thuyết cần kiểm chứng. pg-boss hiện có dashboard,
> dependency workflows, rate limiting, priority và DLQ.

---

## 1. Quyết định

RhinoQ **vẫn là job queue**. Không đổi thành công cụ audit, không đổi thành integrity layer đứng cạnh queue khác.

RhinoQ là job queue bốn lớp. COMMIT và RUN là giá trị nền tảng; VERIFY và
RECOVER là giá trị nhìn thấy được. RECOVER được ưu tiên làm cửa vào vì demo
nhanh, không phải vì ba lớp còn lại chỉ là “cái vỏ”.

| | Vai trò | Bar phải đạt |
| --- | --- | --- |
| COMMIT + RUN | queue foundation — intent bền vững và execution đúng | đạt release gates đã công bố |
| VERIFY + RECOVER | business integrity — phát hiện, giải thích và xử lý sai lệch | tốt hơn cron/SQL/admin rời rạc trên workload thật |

Sai lầm lớn nhất của `RHINOQ.md` bản gốc không phải chọn sai tính năng. Là **thứ tự**: differentiator nằm ở v0.2–v0.3, sau 12–18 tháng xây queue. Với một người làm ngoài giờ, thứ tự đó nghĩa là dự án chết trước khi khác biệt kịp xuất hiện.

**Sửa duy nhất, và là sửa quan trọng nhất trong toàn bộ tài liệu này: differentiator lên sóng ở tuần 8, không phải tháng 12.**

---

## 2. Bản đồ thị trường tháng 7/2026

### 2.1 Đối thủ thật — bảng cũ (mục 6) thiếu một nửa

| Sản phẩm | Hạ tầng | Trong DB của bạn? | Điểm mạnh | Điểm yếu khai thác được |
| --- | --- | --- | --- | --- |
| **BullMQ** | Redis | ❌ | flows/DAG, telemetry, hệ sinh thái chín muồi, có bản Pro | business join cần application/telemetry integration qua hai data store |
| **pg-boss** | Postgres | ✅ | transactional enqueue, dashboard, workflows, priority, rate limit, DLQ | official docs chưa đóng gói outside-in business Rule + Finding lifecycle |
| **Graphile Worker** | Postgres | ✅ | rất nhanh, gọn | không UI, không business context |
| **DBOS** | Postgres | ✅ | durable execution in-process, có Go SDK, hậu thuẫn mạnh | chỉ biết workflow **đã start** — không thấy việc chưa bao giờ được gọi |
| **Hatchet** | Postgres | ❌ (DB riêng) | queue + DAG + durable execution + OTel + multi-tenant | DB tách biệt → mất khả năng join business |
| **Temporal / Restate** | cluster / service | ❌ | mạnh nhất cho orchestration phức tạp | nặng, và cùng mù như trên |
| **Inngest / Trigger.dev** | cloud | ❌ | DX tốt, serverless | payload rời khỏi hạ tầng của bạn |

### 2.2 Product gap cần kiểm chứng, không phải moat không thể copy

> **Tất cả bọn họ đều inside-out: chỉ biết những gì đã đi vào hệ thống của họ.**
> RhinoQ nằm **trong chính database chứa business data** → có thể đi **outside-in**: từ business table ngược về job.

Hệ quả cụ thể:

- BullMQ ở Redis không có relational join trực tiếp; application vẫn có thể nối qua correlation/telemetry
- Hatchet dùng DB riêng → cùng vấn đề
- Durable workflow engine mặc định theo dõi execution đã start; missing intent vẫn cần application rule hoặc reconciliation
- pg-boss ở trong Postgres nên *có thể* làm, nhưng triết lý của nó là tối giản — 8 năm qua chưa làm và sẽ không làm

Đây là lợi thế về default architecture và product packaging. pg-boss hoặc
application code trong cùng Postgres có thể xây khả năng tương tự; RhinoQ phải
thắng bằng baseline, evidence, dedup, lifecycle và safe recovery.

### 2.3 Vì sao không bỏ hẳn queue layer

Bản `RHINOQ_NANG_CAP.md` đề xuất bỏ queue, làm library đứng cạnh BullMQ. Nhanh hơn (6–10 tuần) nhưng sai vì:

| | Bỏ queue | Giữ queue |
| --- | --- | --- |
| Category | **không tồn tại** — không ai search "reconciliation library" | "Postgres job queue" là từ khoá có người tìm |
| Vị thế | phụ kiện cho sản phẩm của người khác | sản phẩm chính |
| Dữ liệu | phải xin từ Redis của BullMQ, chắp vá | sở hữu toàn bộ → timeline liền mạch |
| Tên `RhinoQ` | sai hoàn toàn | đúng |

Không có đường phân phối thì sản phẩm hay đến đâu cũng không ai thấy. Giữ queue.

### 2.4 Bar thật là pg-boss, không phải BullMQ

Mục 9.1 của bản gốc đặt bar ở BullMQ. Sai — và chính cái sai đó làm scope phình gấp ba.

Người dùng mục tiêu là **team đã chọn Postgres, đã từ chối Redis**. Họ không so bạn với BullMQ; họ đã loại BullMQ rồi. Họ so bạn với pg-boss.

Nghĩa là **không cần** ở v0.1: DAG đầy đủ, sandboxed processor hoặc
repeatable-job surface phức tạp. Lý do cắt là chúng không phục vụ integrity
slice đầu tiên, không phải vì pg-boss thiếu các capability đó.

pg-boss hiện có `@pg-boss/dashboard`. Queue Console vì vậy là parity/DX; cửa
vào của RhinoQ phải là business correlation, Rule evidence và Finding
lifecycle.

---

## 3. Ba tính năng cửa vào cho VERIFY và RECOVER

Tiêu chí chọn: **có làm người dùng mở lại vào ngày 30 không?** Feature không vượt qua câu này bị cắt, kể cả khi hay.

### 3.1 Timeline theo correlation — tính năng quan trọng nhất

Nhập `orderId`, thấy toàn bộ câu chuyện trên một dòng thời gian, gộp cả ba nguồn:

```
order_4821                                          14:02:11 → 14:09:40

├─ 14:02:11  business   orders.status = 'pending'
├─ 14:02:11  intent     job#8812 'provision' enqueued  (cùng transaction ✓)
├─ 14:02:40  attempt 1  worker-3   FAILED   DependencyError: provider-a 503
├─ 14:03:10  attempt 2  worker-1   CRASHED  lease expired, không có exit
│            effect     provision-account   ⚠ uncertain
├─ 14:07:55  attempt 3  worker-2   completed  1.2s
├─ 14:08:00  rule       order-must-provision   ✓ pass
└─ 14:09:40  business   orders.status = 'active'
```

**Vì sao đây là tính năng số một:**

- Chuyển RhinoQ từ *"thứ chạy nền, thỉnh thoảng mở"* thành *"thứ mở mỗi khi khách hàng phàn nàn"*. Dùng hàng ngày = retention.
- Không ai copy được. BullMQ không có cột `business`. Hatchet không có. Datadog thấy log nhưng không hiểu semantic job. **Chỉ thứ nằm trong database mới ghép được ba nguồn.**
- Bằng chứng nhu cầu mức A: công ty nào cũng có một trang admin nội bộ "tra order → xem trạng thái", viết đi viết lại, luôn tệ.
- Chi phí thấp: dữ liệu đã có sẵn từ `correlation`, chỉ cần render.

**Yêu cầu kỹ thuật:** cột `business` cần đọc được lịch sử thay đổi trạng thái. Hai cách, chọn cách rẻ:
- Nếu bảng có `updated_at` + cột status → chỉ hiện trạng thái hiện tại (đủ dùng cho v0.1)
- Nếu user khai báo `historyTable` → hiện đầy đủ (v0.2)

Không làm CDC, không làm trigger tự động. Quá xâm lấn cho v0.1.

### 3.2 Rule engine — gộp Outcome và Reconciliation làm một

Bản gốc mô tả chúng như hai hệ thống (mục 11 và 12): 4 cấp outcome, invariant DSL, finality, finding lifecycle riêng. Thực tế chúng khác nhau **đúng một tham số: scope**.

```ts
// scope = 'job' → chính là Outcome cũ
defineRule('credit-must-balance', {
  scope: 'job',
  job: 'settle-scan-credit',
  check: sql`SELECT reserved - consumed - released = 0 FROM credits WHERE scan_id = $1`,
  within: '2m',
})

// scope = 'table' → chính là Reconciliation cũ. Đây là câu không ai trả lời được.
defineRule('order-must-provision', {
  scope: 'table',
  source: sql`SELECT id, created_at FROM orders WHERE status = 'paid'`,
  expect: { job: 'provision', within: '5m', state: 'completed' },
  every: '10m',
  onViolation: 'finding',   // hoặc 'enqueue' | 'log'
})
```

Gộp lại **mất**: `finality`, 4 cấp outcome, invariant DSL. Không cái nào có bằng chứng nhu cầu thật.
Gộp lại **được**: một khái niệm, một UI, một trang docs, cắt ~40% surface area của PHẦN II.

Nguyên tắc 20 của bản gốc — "một canonical API" — áp cho cả khái niệm, không chỉ cho API.

Dùng SQL thật, không DSL. Dev đã biết SQL. Đổi lại **bắt buộc** có `rhinoq explain` chặn rule thiếu index ở CI (mục 11.6e của bản gốc — giữ nguyên, rẻ và cần thiết, một rule tệ có thể giết database production).

### 3.3 Findings lifecycle — phần khó thật sự

Phản biện mạnh nhất: *"query đó tôi tự viết 50 dòng, cần gì library?"*

Đúng. Query là phần dễ. Đây mới là phần không ai tự viết tử tế:

| Vấn đề | Script tự viết | RhinoQ |
| --- | --- | --- |
| Cùng record lệch 10 lần | alert 10 lần → tắt alert | 1 finding, `occurrence_count` tăng |
| Đang xử lý rồi | không có chỗ ghi | `acknowledged` + người nhận |
| Lệch có chủ đích (test data, legacy) | sửa query để loại trừ | `suppressed` + lý do + hạn |
| Sửa xong chưa? | chạy lại query bằng mắt | tự `resolved` khi rule pass |
| Ai sửa, lúc nào | không có | audit log |
| **Bật rule mới trên DB 3 năm tuổi** | **40.000 finding → đóng tab, không quay lại** | `--baseline` mặc định |

`--baseline` là bắt buộc, không phải tuỳ chọn. Mặc định rule chỉ áp cho record tạo sau khi rule bật; quét lịch sử phải chủ động yêu cầu.

Đây là lý do library tồn tại. Không phải query.

### 3.4 `rhinoq scan` — cửa vào, và là lead magnet

Zero-config. Không cần rule, không cần đổi queue, không cần cài gì vào app.

```
$ npx rhinoq scan --db postgres://...

  Tìm thấy 3 bảng có job trỏ vào (qua correlation hoặc tên cột)

  ⚠  orders.status = 'paid'
     p99 thời gian ở trạng thái này: 3 phút
     47 bản ghi đã ở đây > 6 giờ            ← bất thường so với chính bảng này

  ⚠  media_jobs.state = 'processing'
     p99: 90 giây · 8 bản ghi > 2 ngày

  ✓  users.status — không có bất thường

  → rhinoq init --from-scan    (sinh 2 rule từ phát hiện trên)
```

**Ba lý do đây là tính năng bắt buộc có ở v0.1:**

1. **Giải vấn đề "ai viết rule?"** (mục 59.1 bản gốc bỏ ngỏ). Người dùng không viết rule từ trang trắng — họ **xác nhận** rule tool đề xuất. Khác biệt giữa 5% và 60% tỷ lệ hoàn thành onboarding.
2. **Chạy được trên hệ thống đang dùng BullMQ/pg-boss.** Bằng chứng thay cho lời hứa (nguyên tắc 7). Không cần đổi queue để thấy giá trị.
3. **Là nội dung marketing tự chạy.** `npx rhinoq scan` ra kết quả thật về hệ thống thật trong 30 giây — đó là thứ lên được Hacker News, không phải một bài blog về kiến trúc.

**Giới hạn phạm vi — quan trọng:** chỉ quét bảng **có job trỏ vào**. Không quét toàn bộ database. Quét 34 bảng ngẫu nhiên thì RhinoQ thành công cụ giám sát Postgres nói chung, lạc khỏi định vị và cạnh tranh với thứ nó không nên cạnh tranh.

**Ngôn từ:** output phải là *"bất thường so với chính bảng của bạn"*, không phải *"lỗi"*. Sẽ có false positive (bảng legacy, test data, trạng thái treo có chủ đích). Nói sai từ ở đây là mất niềm tin ngay lần chạy đầu tiên.

---

## 4. Hai tính năng giữ chân bổ sung (v0.2)

Không thuộc v0.1, nhưng thiết kế schema từ đầu phải chừa chỗ.

### 4.1 Deploy marker

```
$ rhinoq deploy --sha $GIT_SHA      # một dòng trong CI
```

```
Kể từ deploy a3f9c21 (2 giờ trước):
  ↑ order-must-provision   0.01% → 0.4%   (40×)
  → 23 finding mới, tất cả sau 14:32
```

Sentry giữ chân được ở volume thấp chính nhờ release tracking: nó không bắt bạn nhớ mở tool, nó xuất hiện đúng lúc bạn đang lo. Chi phí: một bảng `deploys` + một cột trên `findings`.

### 4.2 Digest hàng tuần

Webhook/Slack: *3 finding mới · 12 đã xử lý · rule `X` tăng bất thường*.

Kéo người quay lại mà không cần họ nhớ. Chỉ bắn webhook — **không** xây routing, escalation, on-call. Để PagerDuty/Slack làm phần đó.

---

## 5. Cái gì bị cắt, và vì sao

| Cắt | Lý do |
| --- | --- |
| Outcome Level 2, invariant DSL, 4 cấp, `finality` | gộp vào Rule (3.2) |
| Reconciliation Engine như subsystem riêng | gộp vào Rule |
| Effect adapter (Stripe/S3/HTTP) | **xem mục 6** |
| Resource Governor, adaptive concurrency, circuit breaker, fair scheduling, error fingerprint | toàn bộ v0.5 cũ. 0 user thì tối ưu cho ai? |
| Tenant isolation, RBAC, payload classification, audit hash chain, SSRF guard | enterprise feature ở thời điểm 0 user |
| Agent protocol, Go/Python SDK, Intent Bridge cho DB khác | v0.6 cũ. Cắt |
| Handler versioning, durable scheduler | pg_cron và cron thường đã đủ |
| Repair với approval workflow, state hash, plan version/expiry | `--dry-run` + `--limit` + audit log đủ 90% |
| DAG / Flows | BullMQ, Hatchet và pg-boss đã có workflow/dependency primitives; RhinoQ không thắng ở đây |
| Console 4 màn hình | còn 2 (mục 7) |
| BullMQ migration suite 4 công cụ | còn 1 (`scan`) |
| Integrity Score tổng hợp có trọng số | bản gốc loại đúng ở mục 57. Giữ nguyên quyết định |
| Auto-repair không giới hạn | người dùng cần cảm giác kiểm soát |

**Ngoại lệ giữ lại dù nghe như over-engineering:** `lease_epoch` fencing, graceful shutdown 6 bước, clock authority = DB time, không partition hot table. Bốn thứ này **sửa sau rất khó hoặc không sửa được**, và thiếu chúng thì mọi thứ khác vô nghĩa.

---

## 6. Đính chính quan trọng: Effect Ledger không phải điểm bán

Bản gốc (mục 55) coi đây là câu bán hàng mạnh nhất:

> *Worker chết giữa lúc charge thẻ? RhinoQ không retry mù. Nó dừng lại và hỏi bạn.*

**Stripe đã giải bằng idempotency key.** Gửi lại cùng `Idempotency-Key` → trả kết quả lần đầu, không charge lần hai. Adyen, Square, hầu hết payment API hiện đại đều vậy. Với ví dụ flagship của chính tài liệu, retry mù **không nguy hiểm** miễn dev nhớ truyền key.

Đây không giết Effect Ledger, nhưng đổi hoàn toàn lý do tồn tại của nó:

| Lý do cũ (sai) | Lý do mới (đúng) |
| --- | --- |
| "Cho bạn khả năng provider không có" | "Ép bạn dùng khả năng provider đã có, và đừng quên" |
| Capability | **Guardrail + safe default** |

Phạm vi thật còn hai trường hợp:

1. **API không có idempotency** — service nội bộ, SMS/email provider đời cũ, webhook bạn POST đi, thao tác file/media
2. **Dev quên truyền key** — phổ biến nhất, và là giá trị thật của `ctx.effect.run()`

**Hành động bắt buộc:** đổi mọi ví dụ Stripe trong docs và blog sang thứ **không có** idempotency. Viết ví dụ Stripe cho một người hiểu Stripe đọc là mất niềm tin ở dòng đầu tiên — đúng như nguyên tắc 14 cảnh báo.

Ví dụ nên dùng: gọi provisioning API nội bộ · gửi SMS qua nhà mạng · ghi file S3 rồi update DB · POST webhook cho khách hàng.

Bản v0.1 của Effect: ghi `pending` trước, `confirmed` sau, crash ở giữa → `uncertain` → không auto-retry → tạo finding. Không callback `confirm()`, không adapter. Chờ có người xin.

---

## 7. Scope v0.1 và trình tự

**14 hạng mục. Differentiator đầu tiên lên sóng ở tuần 8.**

### Giai đoạn 1 — Queue chạy được (tuần 1–5)

| # | Hạng mục | Ghi chú |
| --- | --- | --- |
| 1 | Schema: `jobs`, `attempts`, `effects`, `rules`, `findings`, `audit` | không partition ở v0.1 — chưa cần, thêm sau được |
| 2 | Transactional enqueue + namespaced idempotency + correlation | mục 8, 43 bản gốc |
| 3 | Batch claim (`FOR UPDATE SKIP LOCKED`) theo slot trống + lease + heartbeat + reaper | mục 26, 42 |
| 4 | Retry + backoff + **jitter** · DLQ · delayed job | mục 9 |
| 5 | **Graceful shutdown 6 bước** + `lease_epoch` fencing ở cả 7 thao tác | mục 9.1, 41.3 — sai chỗ này là duplicate execution |
| 6 | Worker process riêng (`rhinoq work`) + `rhinoq dev` | mục 15, 17.1 |

**Cột mốc tuần 5:** thay được pg-boss trong một app thật của chính bạn.

### Giai đoạn 2 — Khác biệt (tuần 6–10)

| # | Hạng mục | Ghi chú |
| --- | --- | --- |
| 7 | `defineRule` scope `job` + scope `table` + runner | **3.2** |
| 8 | Findings lifecycle + dedup + `--baseline` | **3.3 — phần khó nhất** |
| 9 | `rhinoq fix` — dry-run mặc định, `--limit`, audit | mục 67.3 |
| 10 | `rhinoq explain` — chặn rule thiếu index ở CI | rẻ, ngăn giết DB |
| 11 | Effect ledger tối giản | mục 6 ở trên |

**Cột mốc tuần 10:** demo được câu *"47 order đã thanh toán, chưa từng có job provision"*.

### Giai đoạn 3 — Giữ chân và cửa vào (tuần 11–14)

| # | Hạng mục | Ghi chú |
| --- | --- | --- |
| 12 | **Timeline theo correlation** | **3.1 — tính năng số một** |
| 13 | Console 2 màn hình: Queues (job list, retry, DLQ) + Findings | Queue view là parity; Findings/timeline mới là differentiator |
| 14 | `rhinoq scan` + `init --from-scan` | **3.4 — chạy được cả trên BullMQ/pg-boss** |

**Cột mốc tuần 14:** publish npm.

### Song song, không tính vào scope

- **Module NestJS** — sân nhà, phải tốt nhất. Làm ở tuần 5, khoảng 2 ngày
- **Ma trận crash test công khai** — `kill -9` ở từng điểm vòng đời, kỳ vọng vs thực tế, chạy lại bằng một lệnh. pg-boss và BullMQ không publish cái này. Với lib mới, đây là thứ thay thế một phần cho "8 năm production"
- **Benchmark trung thực vs pg-boss** — kể cả khi chậm hơn. Nói thẳng tạo niềm tin hơn im lặng

**Tổng: 14–16 tuần ngoài giờ.** So với 12–18 tháng của scope cũ.

---

## 8. Kế hoạch có người dùng thật

Đây là phần bản gốc yếu nhất — mục 61 chỉ có "viết 2 bài blog". Không đủ.

### 8.1 Trước khi viết dòng code nào — tuần này

Hỏi 5 dev đang chạy Postgres + background job:

1. Sáu tháng qua có lần nào business record đúng ra phải có job mà lại không có không?
2. **Bạn có cron nào đang quét bảng tìm record kẹt/lệch không? Cho tôi xem đoạn code đó.**
3. Lần cuối phải backfill vài trăm record, bạn làm thế nào? Có sợ không?
4. Bạn đang dùng gì để xem job đang chạy? Có đủ không?

**Câu 2 quyết định tất cả.** Đưa được code ra = nhu cầu đã tồn tại và đang giải bằng tay tệ (bằng chứng mức A). Nếu 4/5 nói "không có cron nào", định vị này sai và phải dừng lại nghĩ, không phải viết code.

Câu 4 kiểm tra giả định ở 2.4 — rằng người dùng pg-boss đang mù.

### 8.2 Kênh phân phối, theo thứ tự ưu tiên

| Kênh | Nội dung | Vì sao |
| --- | --- | --- |
| **`npx rhinoq scan`** | tự nó là marketing | cho kết quả thật trong 30 giây, không cần cài gì. Đây là kênh mạnh nhất |
| **Trang so sánh** | *RhinoQ vs pg-boss*, *vs BullMQ* — trung thực, nói cả chỗ mình thua | người ta search đúng cụm từ này. SEO thật sự hiệu quả cho dev tool |
| **2 bài blog về loại sự cố** | *"Your job queue can't see the work that never entered it"* · *"Job completed is not the same as work done"* | không nhắc RhinoQ ở nửa đầu bài |
| **HN / r/node / r/PostgreSQL** | đăng bài blog, không đăng sản phẩm | "Show HN: sản phẩm mới" chết nhanh; bài kỹ thuật sống lâu |
| **Viblo / J2TEAM** | bản tiếng Việt | có sẵn cộng đồng, dễ có 10 user đầu |
| **Issue trên repo pg-boss/BullMQ** | chỉ khi thật sự liên quan | rất dễ phản tác dụng. Cẩn thận |

**Toàn bộ docs và repo bằng tiếng Anh** (nguyên tắc 12 bản gốc — đúng). Viblo là bản dịch, không phải bản chính.

### 8.3 Kỳ vọng thực tế về số lượng

Nói thẳng để sau này không thất vọng:

- Không dùng download count hoặc market-share estimate không có nguồn và ngày đo làm baseline chiến lược.
- Trần adoption của RhinoQ chưa thể ước lượng trước khi có retention từ Rule/Findings.
- ICP là team có business state có thể lệch: report generation, media processing, provisioning, data sync, payment, credit hoặc inventory.

Đổi lại: BullMQ không có khoảnh khắc nào khiến người ta thấy "hay". Nó là ống nước — cài, chạy, quên, không ai kể cho bạn bè, gần như không ai trả tiền. RhinoQ ở nhóm công cụ chẩn đoán (Sentry, dbt, Snyk): ít người dùng hơn 10–50 lần, nhưng cường độ và khả năng thương mại hoá cao hơn hẳn.

Đó là đánh đổi đúng cho một người làm — vì ở nhóm ống nước bạn không có cửa thắng.

---

## 9. Cảm giác "đẳng cấp" đến từ đâu

Không đến từ nhiều tính năng. Ba thứ, và bản gốc đã có sẵn hai:

- **Đúng và có căn cứ.** Tối thiểu false positive, luôn hiện evidence và confidence; không hứa “zero” khi `scan` dùng heuristic
- **Tiết chế.** `--dry-run` mặc định, `--limit`, `init` chỉ tạo plan cần `--apply` (nguyên tắc 21, 22). Tool cho thấy nó chọn cách an toàn = tool trưởng thành
- **Output đọc được.** Cái timeline ở 3.1. Terminal output **là** UI của bạn ở giai đoạn đầu

Cộng thêm: error message năm phần + `rhinoq doctor` (mục 17.2 bản gốc — giữ nguyên, đây là chi tiết phân biệt tool nghiệp dư với tool chuyên nghiệp).

---

## 10. Chỉ số và tiêu chí dừng

### 10.1 Đo cái gì

| Giai đoạn | Chỉ số | Ngưỡng |
| --- | --- | --- |
| Sau validation (8.1) | dev có cron reconciliation | ≥ 2/5 |
| Tuần 14 (publish) | — | v0.1 lên npm dù còn thiếu |
| +1 tháng | người chạy `rhinoq scan` | ≥ 100 |
| +3 tháng | **user thật** (dùng production, không phải star) | ≥ 3 |
| +6 tháng | issue xin tính năng | ≥ 5 |
| +6 tháng | tỷ lệ user tạo ít nhất 1 rule | ≥ 40% |

Chỉ số cuối là quan trọng nhất: nếu người ta cài RhinoQ và chỉ dùng phần queue, bạn đã làm ra một pg-boss kém hơn.

### 10.2 Dừng nếu

- 4/5 dev không có cron reconciliation nào → nhu cầu không tồn tại
- 3 tháng sau publish, < 3 user thật
- 6 tháng, không ai mở issue → có người cài nhưng không ai dùng nghiêm túc
- < 20% user tạo rule → differentiator không hấp dẫn, chỉ còn là queue thường

### 10.3 Chuyển hướng nếu

- User chỉ dùng `scan` và không bao giờ cài → giá trị ở chẩn đoán, không ở queue → cân nhắc làm tool chẩn đoán độc lập
- User dùng rule nhưng không bao giờ dùng `fix` → giá trị ở phát hiện, không ở sửa → cắt nửa sản phẩm, làm nửa còn lại tốt hơn

---

## 11. Rủi ro chưa giải được

**Rule vẫn là code người dùng phải viết.** Vấn đề 59.1 không biến mất, chỉ nhẹ đi nhờ `scan --from-scan`. Không giải triệt để được.

**Chicken-and-egg của job queue.** Người ta chọn queue bằng "đã chạy production ở bao nhiêu công ty", không bằng spec hay. Giảm nhẹ bằng ma trận crash test công khai và bằng việc `scan` chạy được mà không cần cài. Không xoá được.

**Bạn tự chạy production trước.** Cách rẻ nhất phá chicken-and-egg: dùng chính RhinoQ trong một dự án thật của bạn, và viết về sự cố nó bắt được. Một câu chuyện thật giá trị hơn mười trang README.

**Động lực.** Câu tự hỏi từ mục 60 bản gốc vẫn đúng và vẫn phải trả lời thật: *bạn có thật sự đau vì cái này không?* 14 tuần là dài. Nếu chưa từng đau vì dual-write hay reconciliation, sẽ không đi hết.

---

## 12. Phần nào của `RHINOQ.md` còn sống

### Giữ nguyên, không sửa

Mục 8 (COMMIT) · 9, 9.1 (parity — nhưng **đổi bar sang pg-boss**), 9.2 (retry classification), 9.3 (cancellation), 9.4 (poison job) · 14–17.2 (DX, `rhinoq dev`, canonical API, error message, doctor) · 26 (batch claim theo slot) · 29–32 (bounded storage — **hoãn tới v0.2**, nhưng schema thiết kế từ đầu) · 41–44 (schema, lease, idempotency, append-only) · 47–50.5 (testing, runtime semantics, clock, readiness)

### Sửa

| Mục | Sửa gì |
| --- | --- |
| 6 | thay bằng mục 2 ở đây (thêm DBOS, Hatchet, Graphile Worker) |
| 9.1 | bar là **pg-boss**, không phải BullMQ. Bỏ sandboxed processor và group rate limit khỏi yêu cầu |
| 10–11 | gộp thành Rule engine (3.2) |
| 12–13 | gộp vào findings lifecycle (3.3) |
| 20–23 | Console còn **2** màn hình + timeline |
| 55–56 | thay bằng mục 7 ở đây |
| 61 | thay bằng mục 8 ở đây |

### Bỏ hẳn

Mục 18, 19, 24–28 (trừ 26), 33–40, 45, 46, 51–54, 57

### Phụ lục 24 nguyên tắc

Giữ toàn bộ. Sửa hai chỗ:

- **Nguyên tắc 11:** "Parity là điều kiện cần" → parity với **pg-boss**
- **Thêm nguyên tắc 25:** *Differentiator phải lên sóng trước tháng thứ tư. Tính năng khác biệt nằm sau 12 tháng hạ tầng là tính năng không bao giờ tồn tại.*

---

## 13. Phán quyết

Bản gốc mô tả một sản phẩm cạnh tranh trực diện với BullMQ, pg-boss, DBOS và Hatchet trên sân của họ, bằng một người, trong 12–18 tháng, với differentiator chôn ở v0.2.

Bản này mô tả cùng một sản phẩm, nhưng:

- **Queue chỉ cần bằng pg-boss**, không cần bằng BullMQ — cắt phần lớn scope
- **Differentiator lên sóng tuần 8**, không phải tháng 12
- **Ba tính năng cửa vào** khai thác lợi thế chạy gần business data và đóng gói outside-in workflow tốt hơn cron/SQL rời rạc
- **`scan` chạy được mà không cần cài**, phá được rào cản adoption lớn nhất

> Job queue biết những gì đã đi vào nó.
> RhinoQ biết những gì lẽ ra phải đi vào nó, và những gì đi ra không đúng.
> Nó nói được điều đó bằng outside-in Rule chạy gần business data và một
> Finding lifecycle đóng gói sẵn—không phải vì đối thủ về mặt kỹ thuật không
> thể đứng ở đó.

Mọi tính năng không phục vụ câu đó đều bị cắt, kể cả những tính năng đã được viết rất kỹ trong 2990 dòng trước.
