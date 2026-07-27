# RhinoQ — Business-Integrity Job Queue

> **Run the job. Verify the result. Recover safely.**

RhinoQ là durable job queue dành cho background work quan trọng, nơi _"worker chạy xong"_ chưa đủ và hệ thống cần biết trạng thái nghiệp vụ cuối cùng có thực sự chính xác hay không.

---

## Mục lục

**PHẦN I — ĐỊNH VỊ**

1. [Tên và ý nghĩa](#1-tên-và-ý-nghĩa)
2. [Lời hứa — cái được nói và cái không được nói](#2-lời-hứa--cái-được-nói-và-cái-không-được-nói)
3. [Bốn giai đoạn: COMMIT · RUN · VERIFY · RECOVER](#3-bốn-giai-đoạn-commit--run--verify--recover)
4. [Job queue, không phải message broker](#4-job-queue-không-phải-message-broker)
5. [Bốn vấn đề RhinoQ giải](#5-bốn-vấn-đề-rhinoq-giải)
6. [Đối thủ](#6-đối-thủ)
7. [Vì sao PostgreSQL](#7-vì-sao-postgresql)

**PHẦN II — BỐN LỚP** 8. [COMMIT](#8-commit) 9. [RUN — parity, retry class, cancel, poison-job](#9-run) 10. [VERIFY — Effect Ledger + failure semantics](#10-verify--effect-ledger) 11. [VERIFY — Outcome bốn cấp, finality, query-cost gate](#11-verify--outcome-bốn-cấp) 12. [RECOVER — Reconciliation, finding lifecycle](#12-recover--reconciliation) 13. [RECOVER — Retry, Resume, Repair](#13-recover--retry-resume-repair)

**PHẦN III — DEVELOPER EXPERIENCE** 14. [Hành trình bảy bước](#14-hành-trình-bảy-bước--trang-đầu-của-docs) 15. [Cần chạy bao nhiêu process?](#15-cần-chạy-bao-nhiêu-process) 16. [Một canonical API — ba trang tài liệu](#16-một-canonical-api--không-hai-hệ-cấu-hình-song-song) 17. [Profile kỹ thuật · Outcome hai cấp](#17-profile--kỹ-thuật-không-phải-theo-ngành)
17.2. [Error message và `rhinoq doctor`](#172-error-message-phải-chỉ-đường-sửa) 18. [Handler versioning](#18-handler-versioning) 19. [Durable scheduler](#19-durable-scheduler)

**PHẦN IV — CONSOLE** 20. [Bốn màn hình](#20-bốn-màn-hình) 21. [Queues](#21-queues--màn-hình-cơ-bản-không-được-bỏ) 22. [Business Explorer](#22-business-explorer) 23. [Needs Attention](#23-needs-attention)
23.1. [Job Inspector](#231-job-inspector)

**PHẦN V — PERFORMANCE** 24. [Chỉ Intent nằm trên request path](#24-chỉ-intent-nằm-trên-request-path) 25. [Integrity là opt-in theo job](#25-integrity-là-opt-in-theo-job) 26. [Batch claim và adaptive concurrency](#26-batch-claim-và-adaptive-concurrency) 27. [Resource classes và hard budget](#27-resource-classes-và-hard-budget) 28. [Fair scheduling và circuit breaker](#28-fair-scheduling-và-circuit-breaker)

**PHẦN VI — BOUNDED STORAGE** 29. [Ba tầng dữ liệu](#29-ba-tầng-dữ-liệu) 30. [Payload storage](#30-payload-storage) 31. [Coalescing và error fingerprint](#31-coalescing-và-error-fingerprint) 32. [Storage circuit breaker](#32-storage-circuit-breaker)

**PHẦN VII — SECURITY** 33. [Database roles](#33-database-roles) 34. [Producer và worker bị giới hạn](#34-producer-và-worker-bị-giới-hạn) 35. [Attempt token](#35-attempt-token) 36. [Console auth và RBAC](#36-console-auth-và-rbac) 37. [Payload classification](#37-payload-classification) 38. [Outcome DSL không chạy SQL tuỳ ý](#38-outcome-dsl-không-chạy-sql-tuỳ-ý) 39. [Tenant isolation](#39-tenant-isolation) 40. [Repair security và SSRF protection](#40-repair-security-và-ssrf-protection)

**PHẦN VIII — KỸ THUẬT** 41. [Storage schema](#41-storage-schema) 42. [Dequeue và lease](#42-dequeue-và-lease) 43. [Namespaced idempotency](#43-namespaced-idempotency) 44. [Append-only attempts](#44-append-only-attempts) 45. [Ba deployment mode](#45-ba-deployment-mode) 46. [Migration schema](#46-migration-schema)

**PHẦN IX — TESTING VÀ RELEASE GATE** 47. [Bốn tầng test](#47-bốn-tầng-test) 48. [`rhinoq verify`](#48-rhinoq-verify) 49. [Benchmark gate](#49-benchmark-gate) 50. [Security gate](#50-security-gate)
50.1. [Bằng chứng production](#501-bằng-chứng-production--không-thể-thay-bằng-readme-dài)
50.2. [Runtime semantics — DB outage · clock · restore · readiness](#502-database-outage-semantics)

**PHẦN X — MIGRATION TỪ BULLMQ** 51. [Bốn công cụ, không phải một suite](#51-bốn-công-cụ-không-phải-một-suite) 52. [Drain và cutover](#52-drain-và-cutover)

**PHẦN XI — ĐA NGÔN NGỮ VÀ DATABASE** 53. [Agent, Protocol, SDK](#53-agent-protocol-sdk) 54. [Intent Bridge cho database khác](#54-intent-bridge-cho-database-khác)

**PHẦN XII — THỰC THI** 55. [Scope v0.1](#55-scope-v01) 56. [Roadmap](#56-roadmap) 57. [Loại bỏ và hạ cấp](#57-loại-bỏ-và-hạ-cấp) 58. [Quy tắc quyết định tính năng](#58-quy-tắc-quyết-định-tính-năng) 59. [Vấn đề mở](#59-vấn-đề-mở) 60. [Rủi ro](#60-rủi-ro) 61. [Bước tiếp theo](#61-bước-tiếp-theo) 62. [Phán quyết cuối](#62-phán-quyết-cuối)

---

# PHẦN I — ĐỊNH VỊ

## 1. Tên và ý nghĩa

**RhinoQ** — tê giác. Nặng, bền, da dày, không lay chuyển.

- Package: `rhinoq` / `@rhinoq/core`
- CLI: `npx rhinoq`
- Config: `rhinoq.config.ts` hoặc `rhinoq.yaml`
- DB schema: `rhinoq`

Kiểm tra trước khi cam kết: `npm view rhinoq`, GitHub search, `rhinoq.dev`.

---

## 2. Lời hứa — cái được nói và cái không được nói

### Định vị chính

> RhinoQ là **business-integrity job queue**: ghi nhận background work bền vững, thực thi an toàn, xác minh trạng thái nghiệp vụ quan trọng sau execution, và hỗ trợ phục hồi sai lệch mà không lặp lại những effect nguy hiểm.

### Câu cho người dùng BullMQ

> BullMQ cho biết worker đã hoàn thành job. RhinoQ giúp bạn biết sau lần chạy đó report đã tạo được, media đã xử lý đủ, dữ liệu đã đồng bộ, account đã provision, hoặc trạng thái payment / credit / inventory có thực sự nhất quán hay chưa.

### Tám lời hứa có thể chứng minh

1. Intent không bị mất khi được ghi cùng transaction nghiệp vụ
2. Worker crash không làm mất job
3. Effect irreversible không bị retry mù
4. Job quan trọng có thể khai báo hậu điều kiện nghiệp vụ
5. Sai lệch giữa execution và business state được đưa ra rõ ràng
6. Repair luôn có preview, idempotency và audit
7. Background workload bị giới hạn để không chiếm hết tài nguyên ứng dụng
8. Dữ liệu execution được compact, retention có giới hạn

### Bảy câu KHÔNG được nói

Quá rộng hoặc không thể chứng minh:

- ❌ "RhinoQ bảo đảm mọi business logic đều đúng"
- ❌ "Chỉ RhinoQ có transactional enqueue" — pg-boss cũng có
- ❌ "RhinoQ nhanh hơn BullMQ" — không đúng, và không phải mục tiêu
- ❌ "RhinoQ thay thế Temporal"
- ❌ "Mọi job đều cần Outcome" — phần lớn job không cần
- ❌ "RhinoQ không bao giờ ảnh hưởng database"
- ❌ "RhinoQ không bao giờ làm tăng dung lượng lưu trữ"

---

## 3. Bốn giai đoạn: COMMIT · RUN · VERIFY · RECOVER

Người dùng chỉ cần hiểu bốn lớp. Đây là cấu trúc public của sản phẩm.

```
COMMIT    Công việc có chắc chắn được ghi nhận không?
   ↓      transactional enqueue · local outbox · idempotency
          correlation · payload validation
   ↓
RUN       Công việc có được thực thi và phục hồi đúng không?
   ↓      worker · batch claim · lease · heartbeat · retry + jitter
          delayed jobs · DLQ · durable scheduler · handler version
   ↓
VERIFY    Những thay đổi quan trọng có thực sự xảy ra và nhất quán không?
   ↓      effect state · effect uncertainty · outcome invariant
          deadline · external signal
   ↓
RECOVER   Khi trạng thái sai, có thể điều tra và phục hồi an toàn không?
          reconciliation · resume · repair · dry-run · audit
          Business Explorer
```

### 3.1 Năng lực xuyên suốt — không phải sản phẩm riêng

Bounded storage · Resource Governor · Security · Tenant isolation · Metrics · Agent protocol · SDK · Console · Migration tooling.

Đây là **điều kiện nền** để bốn lớp trên tồn tại được trong production, không phải điểm quảng cáo chính.

### 3.2 Quy tắc lọc

Mọi tính năng không phục vụ trực tiếp một trong bốn giai đoạn phải: chuyển thành infrastructure nội bộ · đưa ra khỏi Core · hoãn tới khi có người dùng thật · hoặc loại bỏ.

---

## 4. Job queue, không phải message broker

|                  | Message broker (RabbitMQ, Kafka, NATS) | RhinoQ                                     |
| ---------------- | -------------------------------------- | ------------------------------------------ |
| Đơn vị           | message cần chuyển                     | công việc cần thực thi và tạo kết quả đúng |
| Sau xử lý        | ack → biến mất                         | lưu state, effect, outcome                 |
| Quan tâm         | routing, throughput, fan-out           | retry an toàn, business state, phục hồi    |
| Câu hỏi vận hành | "message tới chưa?"                    | "credit của SCAN-9218 settle đúng chưa?"   |

### 4.1 Vì sao RhinoQ không cố thành message broker — nói cho đúng

Câu **sai** (và tài liệu này từng viết sai): _"có broker là mất COMMIT"_. Sai vì chính RhinoQ dùng outbox để giữ COMMIT khi bảo vệ intent cho BullMQ (mục 51) và cho database khác (mục 54). Không thể vừa nói broker phá COMMIT, vừa dùng outbox để giải quyết đúng vấn đề đó.

Câu **đúng**:

> **Direct enqueue vào một external broker không thể nằm trong cùng local database transaction.** COMMIT vẫn giữ được bằng local outbox — đổi lại, delivery từ outbox là **at-least-once** và cần **idempotent materialization** ở đầu nhận.

Nghĩa là có ba mức đảm bảo khác nhau, và phải phân biệt rõ:

| Cách                                    | COMMIT                  | Đảm bảo                                                           |
| --------------------------------------- | ----------------------- | ----------------------------------------------------------------- |
| Enqueue trong cùng DB (RhinoQ embedded) | **atomic thật**         | job và business data cùng commit hoặc cùng rollback               |
| Local outbox → broker/RhinoQ            | **atomic ở phía local** | intent không mất; transfer at-least-once; dedupe bằng idempotency |
| Direct enqueue vào broker               | **không có**            | dual-write — lỗi mục 5.1                                          |

**Lý do thật RhinoQ không làm message broker** không phải COMMIT, mà là:

1. **Đơn vị khác nhau.** Broker chuyển _message_ rồi quên; RhinoQ theo dõi _công việc_ qua bốn giai đoạn tới tận business outcome. Effect Ledger và Outcome không có nghĩa với một message đã ack.
2. **Consumer model khác nhau.** Fan-out tới consumer không biết trước làm `verify_state` và `attention_state` mất định nghĩa — outcome của ai, repair cho ai?
3. **Đó là địa hình của RabbitMQ/Kafka/NATS**, 10-15 năm và hàng chục kỹ sư. Cạnh tranh ở đó không thắng được.

Nếu bạn cần topic routing hoặc fan-out, dùng broker — và nếu cần cả transactional intent, dùng **outbox** đứng trước broker đó. Đó chính xác là thứ RhinoQ cung cấp ở mục 51 và 54.

---

## 5. Bốn vấn đề RhinoQ giải

### 5.1 Dual-write (COMMIT)

```ts
await db.transaction(async (tx) => {
  await tx.insert(orders).values(order);
});
await queue.add("provision", { orderId: order.id }); // ← crash ở đây?
```

Crash giữa hai lệnh → order tồn tại, job không bao giờ chạy. Đảo thứ tự → job chạy trên order chưa commit. Rollback → job đã bay ra, không rút lại được.

Im lặng: không exception, không alert. Xảy ra mỗi lần deploy, mỗi lần OOM, mỗi lần pod bị evict.

### 5.2 Retry mù side effect (VERIFY — Effect)

```
t=0  Worker gọi Stripe charge
t=1  Stripe xử lý thành công
t=2  Worker bị SIGKILL trước khi ghi 'completed'
t=3  Reaper thấy orphaned → retry
t=4  Charge lần thứ hai
```

Các queue như BullMQ, pg-boss, RabbitMQ và SQS mặc định chỉ quản lý execution/delivery state, không tự biết semantic của external effect. Nếu ứng dụng không tự xây idempotency, effect ledger hoặc verification, retry có thể lặp lại effect đã xảy ra.

### 5.3 Execution thành công nhưng business state sai (VERIFY — Outcome)

Job chạy xong, log sạch, dashboard xanh — nhưng:

```
credit reserved 20 · consumed 17 · released 0     → lệch 3
payment succeeded  → order vẫn 'awaiting_payment'
API trả 200        → account vẫn 'pending'
scan completed     → còn video chưa terminal state
```

Không ai phát hiện cho tới khi khách hàng gọi.

### 5.4 Công việc chưa từng vào queue (RECOVER)

Order tạo bằng SQL tay · code quên enqueue ở một nhánh if · deploy lỗi làm producer không chạy. Queue **không bao giờ thấy được** loại lỗi này — chỉ Reconciliation đi từ business record ngược về job mới thấy.

---

## 6. Đối thủ

|                       | RhinoQ                                     | BullMQ                               | pg-boss                                    | Inngest       | Temporal      |
| --------------------- | ------------------------------------------ | ------------------------------------ | ------------------------------------------ | ------------- | ------------- |
| Hạ tầng thêm          | **0**                                      | Redis                                | 0                                          | cloud         | cluster       |
| Transactional enqueue | có                                         | không                                | **có**                                     | không         | không         |
| Effect uncertainty    | **có**                                     | không                                | không                                      | không         | một phần      |
| Business invariant    | **có**                                     | không                                | không                                      | không         | không         |
| Reconciliation        | **có**                                     | không                                | không                                      | không         | không         |
| Payload ra ngoài      | không                                      | không                                | không                                      | **có**        | không         |
| Độ phức tạp vận hành  | thấp                                       | trung bình                           | thấp                                       | thấp          | **rất cao**   |
| Throughput            | Chưa công bố nếu chưa có benchmark tái lập | Chưa so sánh trong architecture spec | Chưa công bố nếu chưa có benchmark tái lập | Chưa đánh giá | Chưa đánh giá |

**pg-boss là đối thủ gần nhất** và cũng có transactional enqueue — nên đó _không_ phải điểm khác biệt duy nhất, chỉ là điều kiện cần. Khác biệt thật nằm ở VERIFY và RECOVER.

**Không dùng RhinoQ nếu:** cần topic routing / pub/sub · cần DAG · dùng MySQL/MongoDB làm storage chính (xem mục 54) · queue hiện tại đang chạy ổn và chưa từng bị đau vì dual-write hay retry mù.

RhinoQ không tối ưu cho cùng mục tiêu latency và throughput như một Redis queue. Khả năng thực tế phụ thuộc hardware, payload, worker count, durability và workload; các giới hạn sẽ được công bố bằng benchmark có thể tái lập.

---

## 7. Vì sao PostgreSQL

### 7.1 Nói đúng về Redis và BullMQ

Redis **có** nhiều chế độ persistence (RDB snapshot, AOF với `appendfsync always|everysec|no`) — không phải "không fsync". BullMQ **có thể** giữ completed và failed job qua `removeOnComplete` / `removeOnFail`; giữ hay xoá là lựa chọn cấu hình, không phải giới hạn cứng.

Trade-off thật của việc giữ history dài trên Redis là **memory**: dữ liệu nằm trong RAM, nên retention dài tốn chi phí theo cách khác hẳn so với đĩa.

> Viết sai về đối thủ là cách nhanh nhất để mất niềm tin của người đọc hiểu BullMQ. Nếu họ bắt được một câu sai, họ sẽ nghi ngờ toàn bộ phần còn lại.

### 7.2 Lý do thật để chọn PostgreSQL

RhinoQ chọn Postgres **không phải vì Redis kém**, mà vì bốn lớp COMMIT/RUN/VERIFY/RECOVER cần những thứ mà một relational store cung cấp tự nhiên:

| Cần gì                     | Vì sao Postgres phù hợp                                                         |
| -------------------------- | ------------------------------------------------------------------------------- |
| **Transactional intent**   | job và business data cùng một transaction — không thể có nếu queue nằm ngoài DB |
| **Relational correlation** | join job với business record để tra theo `scanId`, `paymentId`                  |
| **Reconciliation**         | quét business table tìm record thiếu job — cần cùng database                    |
| **Evidence query được**    | filter, aggregate, index tuỳ ý trên lịch sử execution                           |
| **Partition + compact**    | drop partition theo thời gian, giữ storage có biên                              |

Đánh đổi cần được đo bằng benchmark: polling thay vì blocking pop có thể ảnh hưởng latency; không đưa ra claim throughput khi chưa có workload, hardware và phương pháp đo tái lập.

### 7.3 Bù latency ba lớp

`LISTEN/NOTIFY` đánh thức nhanh — **không dùng một mình** vì NOTIFY mất khi mất connection — cộng adaptive polling làm fallback đúng đắn, cộng batch claim theo slot còn trống (mục 26).

---

# PHẦN II — BỐN LỚP

## 8. COMMIT

_Công việc có chắc chắn được ghi nhận không?_

```ts
await db.transaction(async tx => {
  const scan = await tx.insert(scans).values({...}).returning()

  await rhinoq.enqueue('settle-scan-credit', { scanId: scan.id }, {
    tx,
    correlation: [{ type: 'scan', id: scan.id }, { type: 'user', id: userId }],
    idempotency: { namespace: 'scan', key: scan.id },
  })
})
```

Cùng commit hoặc cùng rollback. Không có trạng thái ở giữa.

**Thành phần:** transactional enqueue · local outbox (cho database khác, mục 54) · namespaced idempotency (mục 43) · business correlation · payload validation + size limit (mục 30).

**Intent tồn tại độc lập với execution.** Một intent có thể chưa bao giờ được claim, được claim nhiều lần, có nhiều effect, hoặc có outcome chưa đạt dù mọi execution đã xong. Vì vậy `jobs` là bảng intent, `attempts` là bảng execution — quan hệ 1-n.

---

## 9. RUN

_Công việc có được thực thi và phục hồi đúng không?_

Lớp mà BullMQ và pg-boss cũng có. RhinoQ phải làm **đúng**, không cần làm khác.

| Thành phần        | Ghi chú                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| Batch claim       | `FOR UPDATE SKIP LOCKED` · **claim theo số execution slot còn trống**, không theo số cố định (mục 26) |
| Lease + heartbeat | thay visibility timeout — có owner rõ ràng, gia hạn được                                              |
| Retry             | exponential/linear/fixed + **jitter bắt buộc**                                                        |
| DLQ               | hết attempt → `dead`, không xoá                                                                       |
| Delayed job       | `run_at` absolute time                                                                                |
| Durable scheduler | mục 19                                                                                                |
| Handler version   | mục 18                                                                                                |
| Crash recovery    | reaper phát hiện lease hết hạn                                                                        |

**Về batch claim:** số job claim mỗi lần **luôn** được tính từ slot còn trống. `maxClaimBatch` chỉ là **hard cap** để bảo vệ database, không phải giá trị mục tiêu.

```
available slots = 4 · prefetch = 1.5  → claim = 6
maxClaimBatch = 50                    → cap, không đạt tới trong ví dụ này
```

Không có con số "mặc định 20–100" ở bất kỳ đâu. Xem mục 26 cho lý do đầy đủ.

### 9.1 Parity với BullMQ — điều kiện cần, không phải điểm cộng

> **Nếu phần queue cơ bản tệ hơn BullMQ đáng kể, không ai quan tâm Outcome tốt đến đâu.**

Đây là danh sách phải có **ở v0.1**, không phải roadmap. BullMQ đã giải quyết rất rõ retry, stalled job và rate limiting, và có hướng dẫn tích hợp NestJS chính thức qua `@nestjs/bullmq` — người dùng sẽ so sánh trực tiếp.

| Năng lực                                 | Yêu cầu tối thiểu                                                             | Ghi chú                                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Reliable enqueue                         | có                                                                            | mục 8                                                                                             |
| Worker concurrency                       | per-queue + per-worker, chỉnh runtime                                         |                                                                                                   |
| Retry + exponential backoff + **jitter** | có                                                                            | jitter bắt buộc, không phải tuỳ chọn                                                              |
| Delayed job                              | `run_at` absolute                                                             |                                                                                                   |
| Lease / stalled recovery                 | có                                                                            | mục 42                                                                                            |
| **Graceful shutdown**                    | SIGTERM → ngừng claim, chờ job đang chạy xong, trả lease                      | thiếu cái này thì mỗi lần deploy tạo một loạt job orphaned                                        |
| **Pause / resume queue**                 | per-queue, có hiệu lực ngay qua `LISTEN/NOTIFY`                               | cần khi downstream chết                                                                           |
| **Basic rate limiting**                  | per-queue: N job / khoảng thời gian                                           | group rate limit là v1.x                                                                          |
| **Process isolation**                    | worker chạy process riêng (`rhinoq work`), handler nặng không chặn event loop | tương đương sandboxed processor của BullMQ; không cần bằng tính năng nhưng phải có đường đạt được |
| DLQ                                      | có, không xoá                                                                 |                                                                                                   |
| **Metrics export**                       | `/metrics` Prometheus + OpenTelemetry                                         | không tự dựng monitoring (mục 20)                                                                 |
| **NestJS integration**                   | `RhinoQModule.forRoot()` + decorator                                          | sân nhà, phải tốt nhất                                                                            |

**Graceful shutdown** là mục dễ bỏ sót nhất và tốn kém nhất khi thiếu:

**Sai — release lease khi handler còn chạy:**

```ts
// ❌ NGUY HIỂM
await worker.stopClaiming();
await worker.drain({ timeout: "30s" });
await worker.releaseLeases(); // handler có thể VẪN đang chạy sau 30s
```

Nếu handler chưa xong sau 30 giây, release lease khiến worker khác claim job **trong khi worker cũ vẫn đang thực thi** — hai bản chạy song song, và nếu có effect thì effect chạy hai lần.

**Đúng — sáu bước, chỉ release lease sau khi xác nhận execution cũ đã chết:**

```
1. Ngừng claim job mới
2. Chờ handler kết thúc (grace period)
3. Nếu quá hạn: gửi cancellation signal (ctx.abortSignal)
4. Chờ handler phản hồi cancel
5. Nếu vẫn không dừng: terminate process/thread thực thi
6. CHỈ SAU KHI xác nhận execution cũ đã chết → release lease hoặc requeue
```

```ts
process.on("SIGTERM", async () => {
  await worker.stopClaiming();
  const finished = await worker.drain({ timeout: "30s" });
  if (!finished) {
    await worker.cancelRunning(); // ctx.abortSignal
    const stopped = await worker.awaitStop({ timeout: "10s" });
    if (!stopped) await worker.terminateExecutors(); // chỉ khi process riêng
  }
  await worker.releaseLeases(); // an toàn: không còn handler nào chạy
  process.exit(0);
});
```

**Với inline handler không terminate riêng được:** không chủ động release lease. Để lease hết hạn tự nhiên. Chậm hơn, nhưng an toàn — và đây là lý do `rhinoq work` (process riêng) là cấu hình khuyến nghị cho production.

Thiếu shutdown handler thì mỗi lần deploy để lại một loạt job chờ hết lease mới retry. Nhưng shutdown **sai** còn tệ hơn: nó tạo duplicate execution.

### 9.2 Retry classification — không phải lỗi nào cũng nên retry

Nếu mọi exception đều đi qua `maxAttempts` + exponential backoff, hệ thống sẽ retry lỗi validation vô nghĩa, phình `attempts`, tăng tải dependency, và làm chậm phát hiện dead-letter.

| Class               | Hành vi                                                       | Ví dụ                          |
| ------------------- | ------------------------------------------------------------- | ------------------------------ |
| `transient`         | retry theo policy                                             | timeout mạng, deadlock         |
| `permanent`         | **dead ngay**, không retry                                    | URL không hỗ trợ, schema sai   |
| `rate_limited`      | retry sau `retryAfter` của provider, không dùng backoff riêng | 429                            |
| `dependency_down`   | retry + **feed vào circuit breaker** (mục 28)                 | provider 5xx                   |
| `business_rejected` | dead + ghi lý do nghiệp vụ, không alert kỹ thuật              | thẻ bị từ chối                 |
| `cancelled`         | không retry, không tính là fail                               | mục 9.3                        |
| `unknown`           | retry thận trọng (max 2), rồi `needs_decision`                | exception không phân loại được |

```ts
throw new RhinoPermanentError("Unsupported video URL");
throw new RhinoRateLimitError({ retryAfter: 60_000 });
throw new RhinoDependencyError("provider-a");
```

Error chưa phân loại → `unknown`, không mặc định là `transient`. Mặc định phải là hướng thận trọng.

### 9.3 Cancellation semantics

RhinoQ có retry, resume, repair — nhưng chưa đủ nếu thiếu cancel.

**Trạng thái:** `cancel_requested` · `cancelled` · `cancel_failed`

**Context API:**

```ts
export default async function (payload, ctx) {
  for (const item of list) {
    if (ctx.abortSignal.aborted) return; // cooperative
    await process(item);
  }
}
ctx.onCancel(async () => {
  await cleanup();
});
```

| Tình huống                       | Hành vi                                                                                                               |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Cancel job `pending`             | xoá khỏi hàng đợi ngay → `cancelled`                                                                                  |
| Cancel job `leased`              | **cooperative trước**: set `cancel_requested`, worker thấy qua `abortSignal`. Force chỉ khi worker chạy process riêng |
| Cancel khi effect đang `pending` | **không cancel được** — chuyển `uncertain`, xử lý như mục 10.3                                                        |
| Cancel khi `awaiting_outcome`    | dừng verify, giữ nguyên effect đã confirmed, ghi `cancelled`                                                          |
| Cancel parent                    | **không** tự cancel child (mặc định). Muốn cascade phải khai báo `cancelCascade: true`                                |
| Worker không phản hồi            | sau `cancelTimeout` → `cancel_failed`, hiện lên Needs Attention                                                       |

> **Quy tắc quan trọng nhất: cancel execution không đồng nghĩa rollback effect đã xảy ra.** Muốn rollback phải chạy compensation job riêng — RhinoQ không tự làm, vì nó không biết compensation đúng là gì.

### 9.4 Poison-job protection

Một payload có thể làm worker crash ngay khi deserialize hoặc import handler:

```
claim → worker process crash → lease hết → worker khác claim → lại crash → ...
```

Vòng này phá cả worker fleet mà `maxAttempts` không chặn được, vì job chưa bao giờ chạy đủ lâu để tính là một attempt thất bại bình thường.

```yaml
poisonProtection:
  maxWorkerCrashesPerJob: 3
  maxDistinctWorkersFailed: 2
```

Vượt ngưỡng → `run_state = blocked`, `reason = poison_job`, hiện lên Needs Attention. Không tiếp tục giao cho worker nào nữa.

**Ranh giới quan trọng:** execution completed **không** kết thúc job nếu job có Outcome. Job chuyển `awaiting_outcome`, không phải `completed`.

```
pending → active → executed → awaiting_outcome → achieved
                      ↓              ↓
                   failed      outcome_missed
```

---

## 10. VERIFY — Effect Ledger

Effect **không phải toàn bộ business logic**. Nó chỉ trả lời một câu:

> Một hành động có side effect đã thực sự xảy ra chưa?

### 10.1 Bốn trạng thái

```
pending · confirmed · uncertain · not_happened
```

### 10.2 Quy tắc quan trọng nhất — phải có trước mọi adapter

Nếu worker chết khi một effect **irreversible** đang `pending`:

```
KHÔNG auto-retry
  → chuyển 'uncertain'
  → verify nếu có thể
  → nếu không verify được → 'needs_decision', chờ người
```

> **Thà dừng và hỏi người, hơn là charge hai lần.**

Đây là 90% giá trị thực tế của lớp VERIFY, và nó **không cần** verify tự động.

### 10.3 Khai báo

```ts
export const effects = [
  {
    name: "stripe-charge",
    kind: "http",
    irreversible: true,
    idempotencyKey: (p) => `charge:${p.paymentId}`,
  },
];

export default async function (payload, ctx) {
  const effect = await ctx.effect("stripe-charge"); // ghi 'pending'
  const pi = await stripe.paymentIntents.create(
    { amount: payload.amount },
    { idempotencyKey: effect.idempotencyKey }, // ← truyền xuống Stripe
  );
  await effect.confirm({ ref: pi.id }); // ghi 'confirmed'
}
```

Idempotency key phải **truyền xuống service bên ngoài**, không chỉ dùng nội bộ. Stripe/PayPal tự dedupe theo header — đây là cách an toàn nhất.

### 10.3b State machine đầy đủ

Bốn trạng thái ở trên là tối thiểu cho v0.1. Bản đầy đủ cần tám, vì verify là một quá trình có thời gian chứ không phải một phép kiểm tức thời:

```
not_started ──→ pending ──→ confirmed
                   │
                   ├──→ uncertain ──→ verifying ──→ confirmed
                   │                       │
                   │                       └──→ not_happened ──→ (retry an toàn)
                   │
                   └──→ rejected (provider từ chối rõ ràng)

confirmed ──→ compensated (đã chạy job bù trừ)
```

| State          | Nghĩa chính xác                                                              |
| -------------- | ---------------------------------------------------------------------------- |
| `not_started`  | đã khai báo, chưa mở                                                         |
| `pending`      | request đang chạy                                                            |
| `uncertain`    | worker mất khả năng xác nhận                                                 |
| `verifying`    | đang tra cứu provider (tránh nhiều verifier chạy song song trên cùng effect) |
| `confirmed`    | xác minh đã xảy ra                                                           |
| `not_happened` | xác minh **chắc chắn chưa** xảy ra → retry an toàn                           |
| `rejected`     | provider từ chối rõ ràng (không phải lỗi mạng)                               |
| `compensated`  | đã xảy ra nhưng đã chạy compensation                                         |

Phân biệt `uncertain` với `verifying` quan trọng: không có `verifying` thì nhiều verifier có thể cùng tra một effect, gọi provider API trùng lặp.

### 10.3c Effect fencing — dedupe xuyên attempt

Effect phải gắn với `job_id` · `attempt_id` · `lease_epoch` · `effect_name` · `effect_key`.

```sql
CREATE TABLE rhinoq.effects (
  id            bigserial PRIMARY KEY,
  job_id        bigint NOT NULL,
  attempt_id    bigint,
  lease_epoch   bigint NOT NULL,
  effect_name   text   NOT NULL,
  effect_key    text   NOT NULL,   -- từ idempotencyKey(payload)
  state         text   NOT NULL,
  provider      text,
  idempotency_key text,
  request_hash  text,              -- hash body gửi đi
  key_scope     text,              -- account | endpoint | ...
  provider_retention_hint text,
  external_ref  text,
  opened_at     timestamptz NOT NULL DEFAULT now(),
  confirmed_at  timestamptz,

  CONSTRAINT uq_effect_logical UNIQUE (job_id, effect_name, effect_key)
);
```

`UNIQUE (job_id, effect_name, effect_key)` là chìa khoá: **nếu chỉ gắn effect vào attempt**, retry sẽ tạo effect record mới và mất khả năng dedupe xuyên attempt — đúng lỗi mà Effect Ledger sinh ra để chặn.

Mọi thao tác trên effect phải kiểm `lease_epoch` (mục 41.3).

### 10.4 Effect KHÔNG dùng cho

Phép tính trong memory · database write nằm cùng transaction · tác vụ chạy lại tự do được · cache update · log · temporary file tái tạo được.

Khai báo effect cho những thứ này chỉ tạo overhead vô ích.

### 10.5 Adapter chỉ là primitive

Bốn primitive phủ phần lớn trường hợp: **HTTP idempotency** · **object storage existence** (HEAD object) · **external database reference** · **external signal**.

Không viết hàng chục integration riêng cho từng nhà cung cấp khi chưa có contributor hoặc nhu cầu thật.

### 10.6 Effect không verify được là hợp lệ

`webhook-out` gửi cho đối tác không có API tra cứu là **không thể verify**. Với những effect đó, `needs_decision` là trạng thái cuối cùng hợp lệ, không phải thất bại của thiết kế.

---

### 10.7 Failure semantics table — công bố trong README

RhinoQ **không** ngăn được mọi side effect trùng. Nói thế là lời hứa exactly-once giả. Bảng này phải nằm trong README, không giấu trong docs:

| Tình huống                                              | RhinoQ đảm bảo                                    | RhinoQ KHÔNG đảm bảo                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Provider hỗ trợ idempotency key                         | RhinoQ **tái sử dụng cùng key** khi retry         | mức dedupe phụ thuộc semantics, scope và retention window **của provider** — RhinoQ không kiểm soát được |
| Provider có API tra cứu                                 | verify trước khi retry → không trùng              | —                                                                                                        |
| Provider **không** có idempotency, **không** có API tra | **không retry mù** → `uncertain` → chờ người      | không thể tự biết effect đã xảy ra chưa                                                                  |
| Worker chết sau khi provider xử lý, trước khi confirm   | effect → `uncertain`, job dừng ở `needs_decision` | không tự resolve được                                                                                    |
| Database restore về snapshot cũ                         | phát hiện sequence quay ngược (roadmap)           | effect bên ngoài không rollback theo DB                                                                  |

**Câu được nói:**

> RhinoQ ngăn retry mù khi không đủ bằng chứng để biết effect đã xảy ra chưa.

**Câu không được nói:**

> ❌ RhinoQ ngăn mọi side effect trùng.
> ❌ Provider có idempotency key → effect chạy đúng một lần.

Câu thứ hai sai vì retention window: nhiều provider chỉ nhớ idempotency key trong 24h. Retry sau đó với cùng key sẽ tạo request mới. Vì vậy effect phải lưu `provider_retention_hint`, và nếu retry vượt window thì chuyển `needs_decision` thay vì gửi lại.

**Nếu retry với cùng key nhưng body khác:**

```
IDEMPOTENCY_PAYLOAD_MISMATCH
request_hash lúc đầu: blake3:9f2c...
request_hash hiện tại: blake3:41ab...
→ TỪ CHỐI gửi. Payload đã đổi, key cũ không còn đúng ngữ nghĩa.
```

Câu đầu vẫn là giá trị rất lớn — và đáng tin hơn nhiều so với một lời hứa exactly-once không giữ được. Người dùng phát hiện lời hứa sai một lần là mất niềm tin vĩnh viễn.

---

## 11. VERIFY — Outcome bốn cấp

Outcome là phần dễ biến thành tính năng rác nhất nếu không đặt ranh giới.

### 11.1 Outcome KHÔNG dùng để test lại câu lệnh vừa chạy

```
❌ Job vừa INSERT invoice → Outcome SELECT lại invoice
```

Nếu việc tạo invoice đã nằm trong cùng transaction và được bảo vệ bằng constraint, thì **database transaction và constraint mạnh hơn Outcome**. Verify lại chỉ tốn query.

### 11.2 Outcome chỉ dùng cho business invariant thật

Kiểm tra những quan hệ mà một transaction hoặc một handler riêng lẻ **không thể** bảo đảm:

```
credit reserved = credit consumed + credit released
credit consumed = tổng chi phí các video thực sự ready
payment succeeded → order paid → entitlement active
scan completed CHỈ KHI mọi video có terminal state
```

### 11.3 Bốn cấp

| Cấp                               | Nội dung                                                                                          | Dùng cho                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Level 0 — Execution only**      | không có Outcome                                                                                  | cleanup, cache refresh, telemetry, thumbnail tái tạo được, job không có hậu quả nghiệp vụ |
| **Level 1 — Local postcondition** | record tồn tại · field đạt giá trị · object tồn tại                                               | chỉ khi kết quả **không** nằm trong cùng transaction với handler                          |
| **Level 2 — Business integrity**  | quan hệ giữa nhiều bảng / transaction / job · ledger và balance · count và amount · state machine | workload quan trọng                                                                       |
| **Level 3 — End-to-end**          | hệ thống ngoài · eventual consistency · webhook · signal · deadline theo SLA                      | tích hợp bên thứ ba                                                                       |

> **Phần lớn job phải ở Level 0.** Chỉ workload quan trọng mới dùng Level 2 hoặc 3.

### 11.4 Signal trước, polling sau

```
Nhận signal/webhook
  ↓ (nếu chưa có signal)
Chạy verify
  ↓
Backoff giữa các lần kiểm tra
  ↓
Final verify gần deadline
```

Không cho mỗi job tạo vòng polling độc lập. Agent giữ `next_check_at` / `check_stage` / `deadline_at` trong một timing wheel, không tạo sẵn nhiều job kiểm tra.

### 11.5 Outcome đọc quá sớm — nguồn báo sai lớn nhất

Một trạng thái có thể **chưa cập nhật xong** hoặc **replica đang lag**. Outcome verify đúng lúc đó sẽ báo mismatch giả — và alert giả còn tệ hơn không có alert, vì người ta sẽ tắt nó.

```ts
export const outcome = {
  version: 2,
  notBefore: 0, // mặc định: không tự suy từ telemetry
  deadline: "2m",
  stableFor: "10s", // phải đạt và GIỮ nguyên 10s mới coi là achieved
  readFrom: "primary", // không đọc từ replica đang lag
};
```

**Năm trạng thái, không phải `true/false`:**

| Trạng thái     | Nghĩa                                                                      | Xử lý                              |
| -------------- | -------------------------------------------------------------------------- | ---------------------------------- |
| `pending`      | chưa tới lúc kiểm, hoặc chưa đủ `stableFor`                                | chờ                                |
| `achieved`     | đạt và ổn định                                                             | kết thúc                           |
| `mismatch`     | verify chạy được, kết quả **sai**                                          | alert / repair                     |
| `unverifiable` | không kiểm được (service ngoài chết, thiếu quyền, effect không có API tra) | **không** báo mismatch — báo riêng |
| `stale`        | dữ liệu đọc được cũ hơn ngưỡng cho phép (replica lag)                      | kiểm lại, không kết luận           |

Phân biệt `mismatch` với `unverifiable` là quan trọng: một cái là _business state sai_, cái kia là _tôi không biết_. Gộp chung sẽ tạo hàng loạt false positive khi service ngoài có sự cố.

### 11.6 Outcome phải có version

Business rule đổi sau deploy. Một job enqueue hôm qua không nên bị đánh giá bằng invariant của hôm nay.

```
payload_version
handler_version
outcome_contract_version
repair_policy_version
```

Outcome verify phải dùng **contract version tại thời điểm enqueue**, không phải version hiện tại. Nếu contract cũ không còn tồn tại → `unverifiable`, không phải `mismatch`.

### 11.7 Outcome phải batch được

```
❌ 10.000 outcome → 10.000 SELECT
✓  10.000 outcome → chia batch → một query GROUP BY kiểm tra nhiều business object
```

### 11.8 Finality — khi nào ngừng quan sát

`stableFor` không đủ. Không phải outcome nào cũng cần tiếp tục quan sát sau khi đạt — nếu không, RhinoQ dần biến thành monitoring engine chạy query vô hạn.

```ts
finality: "once" | "stable-window" | "until-deadline";
```

| Giá trị               | Nghĩa                                        | Dùng cho                                |
| --------------------- | -------------------------------------------- | --------------------------------------- |
| `once` ← **mặc định** | đạt một lần là kết thúc, không kiểm lại      | invoice immutable, ledger entry đã post |
| `stable-window`       | phải giữ nguyên hết `stableFor` mới kết thúc | account provisioning (có thể bị revert) |
| `until-deadline`      | kiểm tới hết deadline dù đã đạt              | SLA monitoring                          |

Mặc định phải là `once`. `until-deadline` là ngoại lệ hiếm và phải khai báo có ý thức — nó là thứ tốn query nhất.

### 11.9 Subject version — `readFrom: primary` không đủ

Đọc từ primary chỉ đảm bảo không lag replica. Nó **không chứng minh** verifier đang nhìn đúng version dữ liệu mà job vừa tạo — transaction khác có thể đã ghi đè.

Cần một causal marker, chọn theo hạ tầng có sẵn:

- business row version (`scans.version`)
- commit sequence / LSN
- logical clock
- provider version
- source event ID

```ts
outcomeContract({
  subjectVersion: from("scanVersion"),
  requireObservedVersionAtLeast: from("scanVersion"),
});
```

Nếu verifier đọc được version **cũ hơn** version lúc enqueue → kết luận `stale`, **không phải** `mismatch`. Đây là khác biệt sống còn: `mismatch` gọi người dậy lúc 2 giờ sáng, `stale` chỉ cần kiểm lại sau.

### 11.10 Batch outcome cần contract, không phải callback tuỳ ý

Nếu verifier là callback tự do, RhinoQ **không thể tự batch** — nó không biết query gì để gộp. Contract phải mô tả được cấu trúc:

```ts
outcome.countMatches({
  batchKey: "videos-ready-by-scan",
  groupBy: "scan_id",
  expected: field("scans.successful_count"),
  actual: count("videos", { status: "ready" }),
  tenantField: "tenant_id",
  queryBudget: { maxRows: 100_000, timeout: "2s" },
  contractVersion: 2,
});
```

Bảy thứ contract phải khai báo: `batchKey` · `groupBy` · table/view · tenant field · expected expression · query budget · contract version.

Callback tuỳ ý vẫn được phép — nhưng chạy trong worker của người dùng, không batch được, và phải khai báo rõ là `unbatchable`.

### 11.11 Query-cost gate — chặn contract trước khi lên production

Contract test (mục 47) nói "kiểm tra index" — đây là cách kiểm cụ thể:

```bash
npx rhinoq outcome:explain
```

```
Contract: scan-integrity:v2
Estimated rows:   8,240,000
Sequential scan:  DETECTED on videos
Statement cost:   142,800  (budget: 20,000)
Status: REJECTED

Gợi ý: CREATE INDEX ON videos (scan_id, status);
```

Năm cơ chế: `EXPLAIN` trước khi accept contract · statement timeout · maximum estimated rows · required index declarations · batch size cap.

Một outcome contract thiếu index có thể làm chậm cả database nghiệp vụ — chặn ở CI rẻ hơn phát hiện lúc 2 giờ sáng.

### 11.12 Outcome DSL phải an toàn — không arbitrary SQL

Primitive được phép:

```ts
outcome.recordExists(...)
outcome.fieldEquals(...)
outcome.countEquals(...)
outcome.sumEquals(...)
outcome.exactlyOnce(...)
outcome.signal(...)
outcome.deadline(...)
```

Simple Outcome nên hỗ trợ ORM-aware API để kiểm tra field/key ở compile time:

```ts
outcome.fieldEquals({
  entity: schema.reports,
  key: (payload) => payload.reportId,
  field: (report) => report.status,
  value: "ready",
});
```

Có thể tích hợp metadata từ Drizzle hoặc Prisma. API chuỗi đơn giản vẫn có thể tồn tại cho trường hợp cơ bản, nhưng không nên là API duy nhất.

**Custom verifier chạy trong application worker của người dùng**, không chạy trong Agent (vốn có quyền database cao). Xem mục 38 cho ràng buộc bảo mật.

---

## 12. RECOVER — Reconciliation

### 12.1 Ranh giới với Outcome — không được trùng nhau

|                    | Phạm vi                                       | Ví dụ                                                                    |
| ------------------ | --------------------------------------------- | ------------------------------------------------------------------------ |
| **Outcome**        | một business request / execution cụ thể       | "SCAN-9218 có settle credit đúng không?"                                 |
| **Reconciliation** | quét theo rule tìm drift trong một tập record | "Tìm mọi scan completed trong 24h qua nhưng reserved credit chưa settle" |

### 12.2 Không full scan liên tục

Bắt buộc: incremental cursor `(updated_at, id)` · time-window · batch limit · CDC khi có · full reconcile **chỉ chạy giờ thấp điểm**.

```sql
SELECT id, status, updated_at FROM scans
WHERE (updated_at, id) > (:last_updated_at, :last_id)
ORDER BY updated_at, id LIMIT 1000;
```

Mỗi rule phải khai báo: `scope` · `cursor` · `batch size` · `resource class` · `statement timeout` · `maximum affected records`.

### 12.2b Cursor `updated_at` có thể bỏ sót

`WHERE (updated_at, id) > (...)` bỏ sót record khi: import dữ liệu cũ · restore · timestamp bị backdate · **transaction commit muộn** (row có `updated_at` cũ nhưng chỉ visible sau khi cursor đã vượt qua) · clock lệch giữa các service.

Ưu tiên theo thứ tự:

1. **CDC sequence** (logical decoding LSN) — chính xác nhất
2. **Application change journal** — bảng riêng ghi mọi thay đổi cần reconcile
3. **Monotonic revision** — cột `revision bigserial` tăng theo commit
4. **Timestamp + overlap** — chỉ khi không có ba lựa chọn trên

Với timestamp bắt buộc phải có overlap window:

```
cursor = 12:00  →  lần chạy sau đọc lại từ 11:55
```

Overlap tạo finding trùng, nên phải dedupe (mục 12.2d).

### 12.2c Finding lifecycle

Reconciliation phát hiện mismatch nhưng nếu không có lifecycle, Needs Attention sẽ đầy cảnh báo cũ và không ai đọc nữa.

```
open → acknowledged → repair_proposed → repairing → resolved
  │                                                     │
  ├──→ false_positive (có thời hạn hiệu lực)            │
  ├──→ ignored (có lý do + expiry)                      │
  └──←────────────── regressed ←────────────────────────┘
```

Bốn câu hỏi lifecycle phải trả lời được: finding đã được xử lý chưa? · lỗi đã tự hết chưa? · đã repair nhưng tái xuất hiện không (`regressed` — tín hiệu quan trọng nhất, nghĩa là repair không sửa nguyên nhân gốc)? · `false_positive` có hiệu lực bao lâu?

`false_positive` và `ignored` **phải có expiry**. Đánh dấu vĩnh viễn là cách chôn vấn đề.

### 12.2d Drift deduplication

Rule chạy mỗi phút không được tạo 60 finding cho cùng một scan.

```sql
CREATE TABLE rhinoq.findings (
  rule_id                    text   NOT NULL,
  subject_type               text   NOT NULL,
  subject_id                 text   NOT NULL,
  observed_invariant_version int    NOT NULL,
  status                     text   NOT NULL,
  first_seen                 timestamptz NOT NULL,
  last_seen                  timestamptz NOT NULL,
  occurrence_count           int    NOT NULL DEFAULT 1,
  latest_evidence            jsonb,
  PRIMARY KEY (rule_id, subject_type, subject_id, observed_invariant_version)
);
```

Thấy lại chỉ `UPDATE last_seen, occurrence_count, latest_evidence`. `observed_invariant_version` nằm trong key để khi invariant đổi (deploy mới) thì tạo finding mới thay vì gộp nhầm vào cái cũ.

### 12.3 Không tự repair mặc định

```
detect → explain → preview → chờ phê duyệt
```

Chỉ auto-repair khi **đủ cả năm điều kiện**: rule được đánh dấu safe · operation idempotent · không có effect irreversible · có giới hạn số record · có audit đầy đủ.

---

## 13. RECOVER — Retry, Resume, Repair

Ba thao tác khác nhau về bản chất, không phải ba mức độ của cùng một thứ.

### Retry — chạy lại toàn bộ handler theo policy gốc

Chỉ khi: không có effect đã confirmed · effect an toàn/idempotent · trạng thái lỗi rõ ràng.

### Resume — tiếp tục từ điểm an toàn

Khi: một số effect đã confirmed · không muốn chạy lại toàn bộ handler · workflow có checkpoint hợp lệ. Effect đã confirmed **được bỏ qua**, không gọi lại.

### Repair — sửa business invariant bị lệch

```
reserved = 20 · consumed = 17 · released = 0

Repair đúng:  release 3 credit
Repair sai:   chạy lại toàn bộ scan
```

Repair tác động vào **business state**, không phải chạy lại execution.

### 13.5 Repair plan phải có precondition — nếu không nó nguy hiểm hơn lỗi nó định sửa

Dry-run lúc 12:00 **không có nghĩa vẫn đúng** khi operator bấm Execute lúc 12:03. Trong 3 phút đó business state có thể đã thay đổi — do job khác chạy, do người khác sửa tay, hoặc do chính reconciliation.

**Repair plan phải chứa:**

```json
{
  "planId": "rp_8817",
  "subject": { "type": "scan", "id": "SCAN-9218", "version": 7 },
  "stateHash": "blake3:9f2c...",
  "expiresAt": "2026-07-27T12:05:00Z",
  "expectedChanges": [{ "table": "credits", "op": "release", "amount": 3 }],
  "idempotencyKey": "repair:SCAN-9218:v7"
}
```

**Khi chạy phải compare-and-set:**

```sql
UPDATE credits SET released = released + 3, version = version + 1
WHERE scan_id = $1 AND version = $observedVersion;
-- 0 row affected → business state đã đổi
```

Không khớp thì **từ chối**, không "cố gắng làm cho đúng":

```
REPAIR_PLAN_STALE

Plan #rp_8817 dựng lúc 12:00 dựa trên scan version 7.
Hiện tại scan đang ở version 9.

Không thực thi. Hãy chạy lại dry-run để xem trạng thái mới.
```

Ba lớp bảo vệ, cần **cả ba**: `version` (compare-and-set) · `stateHash` (bắt thay đổi ở field không có version) · `expiresAt` (plan quá cũ tự hết hiệu lực, mặc định 5 phút).

> **Repair không có precondition thì nguy hiểm hơn chính lỗi nó định sửa** — nó sửa dựa trên ảnh chụp đã cũ, và có thể sửa trùng lên một repair khác vừa chạy.

### Mọi repair bắt buộc có

Dry-run mặc định · expected change · affected business objects · effect sẽ bỏ qua · effect sẽ chạy · idempotency key · giới hạn số record · lý do · người thực hiện · audit · **approval thứ hai cho workload nhạy cảm**.

---

# PHẦN III — DEVELOPER EXPERIENCE

> **Nguyên tắc chi phối cả phần này:** tài liệu và API phải _thực sự_ progressive, không chỉ nói là progressive. Nếu ví dụ đầu tiên người dùng thấy đã có `credit-ledger`, effect và outcome, họ sẽ kết luận RhinoQ phức tạp — và đóng tab trước khi biết nó giải vấn đề gì.

## 14. Hành trình bảy bước — trang đầu của docs

### Bước 1 — Cài

```bash
npm i @rhinoq/nest
npx rhinoq init
```

### Bước 2 — Xem RhinoQ sẽ làm gì (chưa làm gì cả)

`init` **chỉ tạo plan**. Không chạy SQL, không sửa file, không gửi request nào:

```
Will create:
  rhinoq.config.ts
  src/jobs/example.ts
  src/rhinoq.worker.ts
  migrations/001_rhinoq.sql

Will modify:
  src/app.module.ts   (+3 dòng: import RhinoQModule)

No database changes have been applied.
No files have been modified.
No network request has been made.

Chạy `npx rhinoq init --apply` để thực hiện.
```

Đây là điểm khác biệt về **niềm tin**, không phải tiện lợi. Một CLI tự sửa file, tự chạy SQL, tự mount route admin sẽ làm người dùng cẩn thận dừng lại ngay — và người dùng cẩn thận chính là đối tượng của RhinoQ.

### Bước 3 — Apply

```bash
npx rhinoq init --apply
npx rhinoq migrate
```

Local dev có thể `autoApply: true`. **Production không bao giờ** — xem mục 46.

### Bước 4 — Tạo job

```ts
export const sendEmail = defineJob({
  name: "send-email",
  handler: async ({ userId }) => {
    await emailService.sendWelcome(userId);
  },
});
```

Không profile. Không effect. Không outcome. Không correlation.

### Bước 5 — Chạy local

```bash
npx rhinoq dev
```

Một lệnh có thể chạy application runtime + worker + Console local, nhưng application command phải được cấu hình rõ ràng:

```ts
export default defineConfig({
  dev: {
    appCommand: "npm run start:dev",
  },
});
```

RhinoQ không thể tự biết ứng dụng dùng `nest start --watch`, `tsx watch`, `nodemon`, `vite`, `next dev` hay một lệnh custom nào. Nếu chưa có `appCommand`, CLI phải báo thiếu cấu hình thay vì giả định cách chạy app.

Phương án tương đương là để CLI sinh scripts:

```json
{
  "scripts": {
    "dev:app": "nest start --watch",
    "dev": "concurrently \"npm run dev:app\" \"rhinoq work\""
  }
}
```

### Bước 6 — Enqueue

```ts
await jobs.sendEmail({ userId });
```

### Bước 7 — Quan sát

```
✓ send-email completed in 420ms
```

### Chỉ SAU khi hoàn thành bảy bước, RhinoQ mới gợi ý bước tiếp theo

```
💡 Job "send-email" gọi một service bên ngoài.
   Bảo vệ nó khỏi retry không an toàn?

   npx rhinoq protect send-email
```

Đây là cách giới thiệu Effect **mà không ép người dùng học trước**. Họ đã có job chạy được, đã thấy giá trị, và giờ mới gặp khái niệm mới — đúng lúc nó có nghĩa với họ.

---

## 15. Cần chạy bao nhiêu process?

Người đọc tài liệu thấy: Application · Worker · Runtime · Agent · Console · PostgreSQL · process isolation — và dễ nghĩ phải deploy năm service. Câu trả lời phải nằm ngay trang đầu:

| Môi trường              | Process                                                  | Ghi chú                                          |
| ----------------------- | -------------------------------------------------------- | ------------------------------------------------ |
| **Development**         | `npx rhinoq dev`                                         | app command đã cấu hình + worker + Console local |
| **Production đơn giản** | API process · Worker process · PostgreSQL                | **đây là mặc định** — hai process, một database  |
| **Production nâng cao** | API · N worker · standalone Agent · Console · PostgreSQL | chỉ khi cần polyglot hoặc tách hoàn toàn         |

> **Standalone Agent không được xuất hiện trong hướng dẫn bắt đầu.** Nó là tuỳ chọn cho polyglot (mục 53), không phải yêu cầu. Trang "Getting Started" chỉ nói tới hai process.

---

## 16. Một canonical API — không hai hệ cấu hình song song

RhinoQ có nguy cơ có sáu cách khai báo job: file-based convention · NestJS decorator · TypeScript config · YAML Blueprint · CLI generate · SQL enqueue function. Người dùng sẽ không biết cách nào là chính thức, dùng YAML rồi có cần TypeScript nữa không, decorator và file-based có dùng chung được không.

### 16.1 Nguồn sự thật duy nhất cho Node: `defineJob`

```ts
export const sendEmail = defineJob({
  name: 'send-email',
  handler: async (payload, ctx) => { ... },
  // mọi thứ khác đều tuỳ chọn:
  // profile, retry, effects, outcome, replay, correlation
})
```

Mọi cách khác **chỉ là adapter hoặc công cụ quanh nó**:

| Cách                     | Vai trò                                                                       |
| ------------------------ | ----------------------------------------------------------------------------- |
| `defineJob` (TypeScript) | **canonical** — nguồn sự thật                                                 |
| NestJS module            | adapter: `RhinoQModule.register([sendEmail])`                                 |
| File-based discovery     | tiện ích: tự tìm `defineJob` export trong `jobs/`                             |
| YAML Blueprint           | **chỉ** cho generate, import/export, ops config — **không chứa handler code** |
| CLI generate             | sinh ra `defineJob` từ YAML                                                   |
| SQL enqueue function     | interface enqueue cho ngôn ngữ khác (mục 53.3)                                |

> **Không có hai hệ cấu hình job độc lập.** YAML không định nghĩa hành vi runtime của job; nó chỉ sinh ra hoặc mô tả `defineJob`. Nếu YAML và TypeScript mâu thuẫn, TypeScript thắng — và CLI phải cảnh báo.

### 16.2 Ba trang tài liệu, ba mức

Docs phải tách thành ba trang riêng, không gộp một trang "API Reference" có đủ mọi thứ.

**Trang 1 — Simple Job.** Chỉ dạy: enqueue · worker · retry · delayed · inspect.

```ts
export const sendWelcomeEmail = defineJob({
  name: "send-welcome-email",
  handler: async ({ userId }) => {
    await emailService.sendWelcome(userId);
  },
});

await jobs.sendWelcomeEmail({ userId });
```

**Trang 2 — Transactional Job.** Chỉ giới thiệu COMMIT, chưa nói gì tới Effect/Outcome.

```ts
await db.transaction(async (tx) => {
  const order = await createOrder(tx);
  await jobs.provisionOrder({ orderId: order.id }, { tx });
});
```

**Trang 3 — Protected Job.** Giờ mới tới Effect, rồi Outcome, rồi Repair.

```ts
export const provisionAccount = defineJob({
  name: "provision-account",
  handler: async ({ orderId }, ctx) => {
    await ctx.effect.run("provision", {
      confirm: "on-return",
      execute: async (effect) =>
        provider.createAccount({
          orderId,
          idempotencyKey: effect.idempotencyKey,
        }),
    });
  },
});
```

### 16.3 Context API

```ts
ctx.effect.run(name, options); // options gồm confirm + execute
ctx.effect(name); // thủ công, cho use case đặc biệt
ctx.heartbeat();
ctx.progress(n);
ctx.log(msg);
ctx.enqueue(name, p);
ctx.abortSignal; // cancellation (mục 9.3)
ctx.onCancel(fn);
ctx.correlation;
ctx.attempt;
```

### 16.4 `effect.run()` phải là mặc định — API thủ công quá dễ dùng sai

```ts
// ❌ Dễ quên confirm()
const effect = await ctx.effect("stripe-charge");
await stripe.charge({ idempotencyKey: effect.idempotencyKey });
// quên await effect.confirm()
// → RhinoQ coi effect là uncertain dù request đã thành công
// → job kẹt ở needs_decision, người vận hành phải xử lý tay
```

Quên một dòng `confirm()` tạo ra đúng loại việc mà RhinoQ sinh ra để giảm. Helper bọc lại toàn bộ vòng đời:

```ts
// Mặc định khi callback return đồng nghĩa effect đã hoàn thành
await ctx.effect.run("create-video", {
  confirm: "on-return",
  execute: async (effect) =>
    provider.createVideo({
      idempotencyKey: effect.idempotencyKey,
    }),
});
```

`confirm: 'on-return'` chỉ phù hợp khi callback trả về đồng nghĩa effect đã hoàn thành. Với provider trả `202 Accepted` hoặc `status: 'processing'`, request mới chỉ được chấp nhận, chưa phải effect confirmed. Có thể chọn policy khác:

```ts
confirm: "external-signal";
confirm: "verify";
confirm: (result) => result.status === "completed";
```

RhinoQ phải phân biệt rõ ba trạng thái: **Request accepted** · **Effect confirmed** · **Outcome achieved**. Callback return không tự động chứng minh cả ba.

API thủ công vẫn giữ cho trường hợp effect kéo dài qua nhiều bước hoặc confirm đến từ webhook — nhưng docs, lint rule và `rhinoq doctor` đều đẩy người dùng về `effect.run()`.

---

## 17. Profile — kỹ thuật, không phải theo ngành

Người cài đặt không nên phải quyết định về connection budget, claim batch, lease, heartbeat, retry class, rate limit, storage budget, retention, isolation, outcome query cost. Những thứ đó hợp lý ở engine, không hợp lý ở dòng đầu tiên của người dùng.

Profile trước đây đặt theo ngành (`payment`, `provisioning`) — sai, vì người dùng không biết job của mình thuộc "ngành" nào. Đặt theo **đặc tính kỹ thuật**:

```ts
defineJob({ profile: "external-api" });
```

| Profile              | Đặc tính              | Tự cấu hình                                                                                                                                |
| -------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `default` ← mặc định | job ngắn, nội bộ      | retry 3 · timeout 30s · concurrency 10                                                                                                     |
| `external-api`       | gọi service bên ngoài | retry 5 + jitter mạnh · tôn trọng `retryAfter` của 429 · circuit breaker · concurrency vừa phải · timeout 30s                              |
| `long-running`       | chạy phút tới giờ     | lease 10 phút · heartbeat bắt buộc · overlap skip · cancellation cooperative                                                               |
| `cpu-heavy`          | chiếm CPU             | worker process riêng bắt buộc · concurrency thấp · memory limit                                                                            |
| `high-volume`        | rất nhiều job nhỏ     | batch claim lớn hơn · progress coalescing chặt · retention ngắn                                                                            |
| `business-critical`  | có hậu quả nghiệp vụ  | idempotency bắt buộc cho các effect đã khai báo · audit đầy đủ · unknown error fail-closed · replay bị giới hạn · outcome được khuyến nghị |

`business-critical` không mặc định mọi effect là irreversible. Mỗi effect phải tự khai báo semantics: đọc provider không phải effect; upload object có thể idempotent; reserve inventory có thể reversible; charge card có thể irreversible; gửi email có thể chấp nhận trùng tùy hệ thống. Profile yêu cầu idempotency cho các effect đã khai báo, audit đầy đủ, unknown error fail-closed và replay bị giới hạn. `irreversible` là thuộc tính của từng effect, không phải của toàn bộ job.

Người dùng chỉ override khi cần:

```ts
defineJob({ profile: "external-api", retry: 8 });
```

### 17.1 Outcome hai cấp

Các khái niệm `batchKey` · `groupBy` · `contractVersion` · `subjectVersion` · `finality` · `stableFor` · `queryBudget` · `readFrom` đều đúng về kỹ thuật nhưng quá nhiều cho lần đầu. **90% người dùng không nên nhìn thấy cấu hình advanced.**

**Simple Outcome — cấp mặc định:**

```ts
outcome: {
  within: '2m',
  expect: outcome.fieldEquals({
    entity: schema.reports,
    key: (payload) => payload.reportId,
    field: (report) => report.status,
    value: 'ready',
  }),
}
```

RhinoQ tự điền: `finality: 'once'` · `readFrom: 'primary'` · `notBefore: 0` · `queryBudget` mặc định · contract version = 1. RhinoQ có thể đề xuất `notBefore` dựa trên telemetry, nhưng developer phải chấp nhận đề xuất trước khi giá trị được ghi vào config; không tự động áp dụng theo p50 runtime.

ORM-aware API này giảm lỗi do tên bảng/field viết sai. Metadata có thể đến từ Drizzle hoặc Prisma. Simple Outcome cần dễ, nhưng không nên trở thành API chuỗi hoàn toàn.

**Advanced Outcome — khi thật sự cần:**

```ts
outcomeContract({
  version: 3,
  subjectVersion: from("scanVersion"),
  finality: "stable-window",
  stableFor: "10s",
  batchKey: "videos-ready-by-scan",
  queryBudget: { maxRows: 100_000, timeout: "2s" },
});
```

Docs phải để Advanced ở **trang riêng**, không phải phần cuối của trang Simple.

---

## 17.2. Error message phải chỉ đường sửa

Sản phẩm dễ dùng không chỉ ở happy path — nó phải dạy người dùng sửa lỗi. Mọi error của RhinoQ theo **năm phần**:

```
RHINOQ_LEASE_TOO_SHORT

What happened
  Job "transcode-video" có lease 60s nhưng p99 runtime là 94s.

Why it matters
  Job có thể bị hai worker thực thi cùng lúc.
  Nếu job có effect irreversible, side effect sẽ chạy hai lần.

What RhinoQ did
  Chưa làm gì. Đây là cảnh báo, job vẫn đang chạy với cấu hình hiện tại.

How to fix
  defineJob({ lease: '180s' })
  hoặc: defineJob({ heartbeat: 'automatic' })

Verify
  npx rhinoq doctor --job=transcode-video
```

Năm phần: **What happened · Why it matters · What RhinoQ did · Exact fix · Command to verify.**

Phần "What RhinoQ did" là thứ hiếm thấy nhưng quan trọng nhất khi có sự cố — người vận hành cần biết hệ thống đã tự làm gì trước khi họ can thiệp.

### 17.2.1 `rhinoq doctor` là một phần chính của DX

Không chỉ kiểm database (mục 46). Phải kiểm toàn bộ:

```bash
npx rhinoq doctor
```

```
Setup
  ✓ Migration version khớp (v4)
  ✓ Console auth đã cấu hình
  ✗ Job "send-report" đã định nghĩa nhưng chưa register ở worker nào

Runtime
  ✓ 3 worker đang chạy, heartbeat bình thường
  ⚠ Clock skew worker-2 vs DB: 7s        (ngưỡng 5s)
  ✓ Queue backlog trong ngưỡng

Configuration
  ⚠ transcode-video: lease 60s < p99 runtime 94s
  ⚠ import-csv: payload p95 = 1.2MB (khuyến nghị < 256KB)
  ✗ charge-card: effect irreversible thiếu idempotencyKey

Outcome
  ✗ scan-integrity:v2 — sequential scan trên videos
      → CREATE INDEX ON videos (scan_id, status);

Database
  ✓ RhinoQ dùng 4/5 connection budget
  ✓ jobs_hot: 1,204 rows
  ⚠ attempts chưa partition
```

`doctor` chạy được ở CI (`--ci` trả exit code khác 0 nếu có ✗) và là điều kiện của `rhinoq verify` (mục 48).

---

## 18. Handler versioning

Job enqueue ở code cũ, chạy sau khi deploy code mới. Payload có thể không tương thích.

RhinoQ lưu: `payload_version` · handler version lúc enqueue · handler version lúc execute · git commit/release · worker version.

```ts
export const config = {
  version: 3,
  migratePayload: { 1: (p) => v1ToV2(p), 2: (p) => v2ToV3(p) },
};
```

Không có đường migrate → job giữ ở `blocked`. **Không mất, không fail thầm.**

---

## 19. Durable scheduler

```ts
rhinoq.schedule("daily-settle", "0 6 * * *", handler, {
  timezone: "Asia/Ho_Chi_Minh",
  onMissed: "run-once",
  overlap: "skip",
  alertIfNotRunWithin: "2h",
});
```

**Năm thứ `node-cron` không làm được:**

1. **Chạy đúng một lần trên nhiều instance** — `FOR UPDATE SKIP LOCKED` trên hàng schedule, không cần Redis lock
2. **Không mất lượt khi app chết** — lưu `next_run_at`, sống lại chạy bù
3. **Không chạy đè lên chính nó** — `overlap: 'skip'`
4. **Biết được nó đã chết** ← đáng giá nhất. Scheduler chết là lỗi im lặng tuyệt đối: không exception, không log. Ba tuần sau khách hàng mới nói
5. **Timezone + DST đúng** — chỗ hầu hết implementation tự viết đều sai

Parse cron dùng `cron-parser`, không tự viết.

---

# PHẦN IV — CONSOLE

## 20. Bốn màn hình

Bản trước nói _"không có queue depth, chỉ có việc cần xử lý"_ — **hơi cực đoan**. Người vận hành vẫn cần biết queue có đang nghẽn hay không, và nếu Console không trả lời được thì họ phải cài thêm một dashboard chỉ để biết điều đó.

| Màn hình                 | Trả lời câu gì                      | Ai dùng      |
| ------------------------ | ----------------------------------- | ------------ |
| **1. Queues**            | Hệ thống có đang nghẽn không?       | ops, dev     |
| **2. Business Explorer** | Đơn/scan/payment này đang ở đâu?    | support, dev |
| **3. Needs Attention**   | Việc gì cần người xử lý?            | ops          |
| **4. Job Inspector**     | Job cụ thể này đã xảy ra chuyện gì? | dev          |

Retry · Resume · Verify · Repair là **action trong Inspector**, không phải màn hình riêng.

### Không làm ở v0.1

Integrity score · generic anomaly detection · dynamic baseline · incident lifecycle phức tạp · root-cause AI · dashboard chart trang trí · full runtime config editor.

Generic metrics **export ra ngoài** (Prometheus / OpenTelemetry), không tự dựng monitoring stack trong Console.

---

## 21. Queues — màn hình cơ bản không được bỏ

```
QUEUES

NAME                PEND  ACTIVE  DELAY  RETRY  DEAD   OLDEST   RATE     DRAIN    STATE
send-email            12       3      0      1     0    1.2s    45/m     ~20s    running
provision-account      0       1      4      0     2    840ms    8/m        —     running
transcode-video    1,204      20    120     18     3   14m 20s   22/m    ~54m     running
settle-credit          0       0      0      0     0       —      3/m        —    PAUSED ⏸
```

Chín cột, mỗi cột trả lời một câu hỏi vận hành thật:

| Cột                                          | Vì sao cần                                                    |
| -------------------------------------------- | ------------------------------------------------------------- |
| Pending / Active / Delayed / Retrying / Dead | phân bố cơ bản — thiếu là phải cài dashboard khác             |
| **Oldest pending age**                       | chỉ số tốt hơn depth ở mọi tình huống (mục 27)                |
| Throughput                                   | job/phút hiện tại                                             |
| **Estimated drain time**                     | ước lượng phải kèm confidence, cửa sổ dữ liệu và phạm vi tính |
| **Paused hay không**                         | queue bị pause mà không ai biết là sự cố im lặng              |

Nhấn vào một queue → lịch sử 24h của các chỉ số trên + link sang Needs Attention đã lọc theo queue đó.

Ví dụ hiển thị:

```
Estimated drain: ~54m
Confidence: low
Based on last 15m successful throughput
Excludes delayed jobs
```

Ước lượng phải phản ánh job duration, rate limit, throughput bằng 0, retry storm, delayed jobs, priority classes và việc worker đang scale. Không đủ dữ liệu thì hiển thị `Drain estimate unavailable`.

Đây **không phải** "queue depth dashboard" kiểu cũ: nó không cố thay Grafana, chỉ trả lời đúng câu _"có đang nghẽn không, và ước lượng hiện tại đáng tin đến mức nào"_.

---

## 22. Business Explorer

Tìm theo business key, không phải job ID: `orderId` · `paymentId` · `scanId` · `userId` · email · external reference.

```
SCAN-9218                                      user: USR-1928

  COMMIT    3 intent đã ghi nhận
  RUN       3 executed
  VERIFY    2 effect confirmed · 1 uncertain ⚠ · 1 invariant MISMATCH ⚠
  RECOVER   1 repair pending

  #48289  reserve-credit       achieved         10:32:04
  #48290  process-videos       needs_decision   10:32:09  ⚠ effect uncertain
  #48291  settle-scan-credit   outcome_missed   10:32:44  ⚠ reserved ≠ consumed + released

  reserved 20 · consumed 17 · released 0 → lệch 3
```

Đây là màn hình **support dùng được mà không cần hiểu queue**. Nếu RhinoQ chỉ phục vụ backend dev thì adoption chậm.

---

## 23. Needs Attention

Màn hình người vận hành mở hằng ngày. Sáu loại, và **chỉ** sáu loại:

| Loại             | Nghĩa                                                      |
| ---------------- | ---------------------------------------------------------- |
| Effect uncertain | không rõ side effect đã xảy ra chưa — cần người quyết định |
| Outcome mismatch | execution xong nhưng business state sai                    |
| Missing intent   | business record không có job tương ứng                     |
| Dead job         | hết attempt                                                |
| Repair pending   | có repair plan chờ phê duyệt                               |
| Cancel failed    | worker không phản hồi lệnh cancel (mục 9.3)                |

Mỗi mục hiện kèm **finding lifecycle** (mục 12.2c) — đã acknowledge chưa, đã repair chưa, có `regressed` không. Không có lifecycle thì màn hình này đầy cảnh báo cũ sau hai tuần và không ai đọc nữa.

---

## 23.1. Job Inspector

Hiển thị theo đúng bốn giai đoạn, và là nơi chứa mọi action:

```
Job #48291  settle-scan-credit

COMMIT   intent committed 10:32:44 · idem scan:SCAN-9218 · correlation scan,user
RUN      attempt 1: executed 1.29s · worker credit-2 · handler 1.4.2 · epoch 1
VERIFY   effect credit-debit: confirmed (ref led_88213)
         outcome: reserved(20) ≠ consumed(17) + released(0)  → MISMATCH
RECOVER  repair đề xuất: release-remainder 3 credit

ACTIONS  [ Retry ]  [ Resume ]  [ Verify lại ]  [ Repair dry-run ]  [ Cancel ]
```

Action nào không hợp lệ thì **disabled kèm lý do**, không ẩn đi:

```
[ Retry ]  ⊘ Không khả dụng: effect credit-debit đã confirmed.
             Dùng Resume để bỏ qua effect đã xảy ra.
```

Ẩn nút làm người dùng tưởng tính năng không tồn tại. Disable kèm lý do vừa chặn thao tác sai, vừa dạy họ mô hình của RhinoQ.

---

# PHẦN V — PERFORMANCE

## 24. Chỉ Intent nằm trên request path

Request **không được chờ**: worker chạy · effect verify · outcome · reconciliation · repair.

```
Business transaction → ghi business data → ghi job intent → COMMIT → trả response
```

Đây là ràng buộc kiến trúc, không phải tối ưu. Vi phạm nó là biến RhinoQ thành nguồn latency của API.

---

## 25. Integrity là opt-in theo job

Không phải job nào cũng chịu chi phí Effect và Outcome:

```ts
integrity: "execution"; // chỉ COMMIT + RUN — mặc định
integrity: "effect"; // + Effect Ledger
integrity: "business"; // + Outcome invariant
```

Job cleanup và cache refresh không nên trả giá cho cơ chế dành cho payment.

---

## 26. Batch claim và adaptive concurrency

**Batch claim theo slot còn trống, không theo số cố định:**

```
claim_limit = available_execution_slots × prefetch_factor
```

```
concurrency = 20 · đang chạy = 18 · available = 2 · prefetch = 1.5 → claim 3
```

Claim 100 job khi chỉ chạy được 10 gây bốn vấn đề: 90 job bị giữ lease · worker khác không lấy được · fairness giảm · **lease có thể hết trước khi job kịp bắt đầu xử lý** — job bị coi là orphaned dù chẳng ai crash.

`prefetch_factor` mặc định 1.5, tối đa 3. Chỉ tăng khi handler rất ngắn và DB latency cao.

`maxClaimBatch` (mục 27) là **hard cap bảo vệ database**, không phải batch size mục tiêu:

```
available slots = 4 · prefetch = 1.5 → claim = 6
maxClaimBatch = 50                   → không chạm cap

available slots = 60 · prefetch = 1.5 → tính ra 90
maxClaimBatch = 50                    → claim 50
```

Đây là quy tắc duy nhất trong toàn tài liệu. Không có con số batch cố định ở bất kỳ mục nào khác.

**Adaptive concurrency (AIMD):**

```
DB khoẻ:      concurrency += 1        (tăng từ từ)
DB có áp lực: concurrency ×= 0.5      (giảm mạnh ngay)
```

Tín hiệu: query p95 · connection wait · WAL rate · lock wait · replication lag · disk latency.

> ⚠ `mode: automatic` **không ship** cho tới khi có test tải mô phỏng nhiều tuần trên staging của chính RhinoQ. `mode: recommend` (chỉ đề xuất, không tự làm) là mặc định bắt buộc. Auto-tune sai không phải "chưa tối ưu" — nó là outage trên production của người khác.

---

## 27. Resource classes và hard budget

```
critical · interactive · standard · batch · maintenance
```

Khi database chịu tải, giảm theo thứ tự: **1)** pause maintenance → **2)** giảm batch → **3)** giảm standard → **4)** giữ critical ở concurrency tối thiểu.

**Hard budget — RhinoQ không được tự vượt:**

```yaml
database:
  maxConnections: 5
  maxClaimBatch: 50
  maxStatementTime: 2s
  maxReplicationLag: 5s
```

Pool riêng, không dùng chung với API: `API 30 · RhinoQ 5 · reserved 3`.

---

## 28. Fair scheduling và circuit breaker

### 28.1 Fair scheduling — chọn một, đừng ghi tên thuật toán không implement

Tài liệu không được ghi "Weighted Deficit Round Robin" trong khi SQL chỉ có `ORDER BY priority DESC, run_at`. Đó không phải WDRR. Hai lựa chọn:

**A. Thiết kế đơn giản (khuyến nghị cho v0.1)**

```
priority + FIFO trong cùng priority + priority aging
```

Aging: job chờ quá `agingThreshold` thì tăng priority — chống starvation mà không cần scheduler riêng. Thực hiện được hoàn toàn trong SQL:

```sql
ORDER BY (priority + LEAST(EXTRACT(epoch FROM now() - run_at) / 3600, 5)) DESC, run_at
```

**B. WDRR thật (v0.5)**

Runtime giữ deficit counter riêng cho từng resource class. Trước mỗi vòng claim, scheduler tính **mỗi class được claim bao nhiêu job**, rồi chạy N query riêng theo class — không phải một query `ORDER BY priority`.

```
critical 10 · interactive 5 · standard 2 · batch 1   (deficit weights)
```

v0.1 dùng A và **ghi rõ là A**. Đổi sang B ở v0.5 khi có runtime scheduler.

### 28.2 Admission control — producer backpressure

Hard budget (mục 27) giới hạn worker và database operation. Nhưng nếu producer enqueue nhanh hơn khả năng xử lý, `jobs_hot` vẫn phình — **worker backpressure không cứu được**.

```yaml
queue:
  maxPendingJobs: 100000
  maxPendingBytes: 2GB
  onOverflow: reject | delay | route | sample
  criticalReservedSlots: 5000
```

```
RHINOQ_QUEUE_OVER_CAPACITY
queue: video-transcode · pending: 100,000 / 100,000
retryAfter: 30s
```

`criticalReservedSlots` giữ chỗ cho `resource_class: critical` — queue report tràn không được chặn job payment.

Bốn chế độ overflow: `reject` (trả lỗi, producer tự xử lý) · `delay` (chấp nhận nhưng `run_at` lùi) · `route` (đẩy sang queue khác) · `sample` (chỉ nhận một phần — chỉ dùng cho telemetry).

> Chỉ có worker backpressure mà không có producer backpressure thì hệ thống vẫn chết vì backlog.

**Retry circuit breaker** — nhóm lỗi theo `(job_name, dependency, error_fingerprint)`. 50 lỗi giống nhau trong 10 giây → mở circuit: không claim thêm job phụ thuộc · không tạo thêm attempt row · gom vào `waiting_dependency` · sau cooldown chạy probe · thành công thì tăng tốc dần.

Ngăn: database phình vì retry storm · đối tác bị gọi dồn dập · worker ăn hết CPU · queue khác starvation.

---

# PHẦN VI — BOUNDED STORAGE

## 29. Ba tầng dữ liệu

RhinoQ **không hứa** database không tăng. RhinoQ hứa:

> **Hot tables không tăng theo toàn bộ lịch sử của hệ thống.**

| Tầng                 | Chứa gì                                                                 | Cơ chế                     |
| -------------------- | ----------------------------------------------------------------------- | -------------------------- |
| **Hot state**        | pending · active · awaiting outcome · needs decision · terminal gần đây | cột hẹp, partial index nhỏ |
| **Recent evidence**  | attempts · effects · timeline · audit gần đây                           | partition theo thời gian   |
| **Evidence capsule** | job cũ compact thành một summary                                        | archive ra object storage  |

```json
{
  "job": "settle-credit",
  "result": "achieved",
  "attempts": 2,
  "effects": { "credit-debit": "confirmed" },
  "outcome": "achieved",
  "handlerVersion": "1.4.2",
  "evidenceHash": "..."
}
```

**Không bulk delete.** Retention dùng partition detach → drop → archive → compact. Không `DELETE` hàng triệu row (tạo dead tuple, áp lực autovacuum).

---

## 30. Payload storage

```
≤ 4 KB          → inline
4 KB – 256 KB   → compress (Zstandard) + blob reference
> 256 KB        → object storage reference
binary          → luôn từ chối
```

Từ chối ngay ở producer, không để vào DB rồi mới phát hiện:

```
RhinoQPayloadTooLarge — 2.4 MB, tối đa inline 256 KB.
Hãy upload lên object storage và enqueue object reference.
```

### 30.1 Deduplication và vấn đề refcount

Content hash (`BLAKE3(canonicalJson(payload))`) để không copy cùng payload vào jobs, attempts, audit, replay, timeline.

Nhưng **refcount realtime có race condition**:

```
insert job → increment refcount → job rollback → decrement bị bỏ lỡ
sweeper crash giữa delete job và decrement → refcount sai vĩnh viễn
```

Hai hướng an toàn, phải chọn rõ một:

**A. Mark-and-sweep định kỳ (khuyến nghị)** — không giữ refcount realtime:

```sql
-- Blob không còn ai tham chiếu, và đã quá grace period
DELETE FROM rhinoq.payload_blobs b
WHERE b.created_at < now() - interval '7 days'
  AND NOT EXISTS (SELECT 1 FROM rhinoq.jobs_hot WHERE payload_ref = b.hash)
  AND NOT EXISTS (SELECT 1 FROM rhinoq.history  WHERE payload_ref = b.hash)
  AND NOT EXISTS (SELECT 1 FROM rhinoq.attempts WHERE payload_ref = b.hash);
```

Grace period bắt buộc — chống race giữa "tính hash rồi" và "chưa insert job".

**B. Refcount transactional chặt** — mọi add/remove reference **cùng transaction** với thao tác job, cộng một job reconciliation định kỳ đối chiếu refcount với thực tế.

Không mô tả rõ một trong hai thì blob storage sẽ **leak** hoặc **xoá nhầm payload còn dùng**. Cái sau tệ hơn nhiều: job không replay được, evidence mất.

---

## 31. Coalescing và error fingerprint

**Progress/heartbeat coalescing** — chỉ persist khi: thay đổi ≥5% · hoặc quá 5 giây · hoặc terminal event. Không ghi mỗi phần trăm, không update lease mỗi giây.

**Error fingerprint** — retry storm tạo hàng triệu stack trace giống nhau:

```
fingerprint = hash(jobName + errorType + normalizedStack + dependency)
```

```
error_fingerprints: fingerprint · first_seen · last_seen · occurrence_count · example_stack
```

Attempt chỉ giữ reference. 84.921 lỗi giống nhau → một stack trace.

---

## 32. Storage circuit breaker

**"70% của cái gì" phải cấu hình rõ** — runtime không biết quota của RDS, Neon, Supabase hay Cloud SQL:

```yaml
storage:
  rhinoqBudgetBytes: 10737418240 # 10GB — ngân sách RhinoQ tự đo được
  warningAt: 0.70
  compactAt: 0.80
  minimalEvidenceAt: 0.90
```

RhinoQ đo dung lượng **schema `rhinoq`** so với `rhinoqBudgetBytes` do người dùng cấp, không đoán quota của cả instance.

| Ngưỡng  | Hành động                                                               |
| ------- | ----------------------------------------------------------------------- |
| **70%** | cảnh báo · nén dữ liệu cũ · giảm debug retention                        |
| **80%** | compact success history · archive payload · drop success progress event |
| **90%** | **Minimal Evidence Mode**                                               |

Minimal Evidence Mode giữ: intent · active · unresolved effect · outcome mismatch · dead job · final summary.
Loại trước: progress history · success log · debug message · duplicate stack trace · metric độ phân giải cao.

> **Không bao giờ xoá unresolved effect để giữ log.** Thiếu dung lượng thì hy sinh dữ liệu quan sát, không hy sinh dữ liệu nghiệp vụ.

---

# PHẦN VII — SECURITY

Security ở đây **là release gate**, không phải mục tuỳ chọn. Xem mục 50 cho checklist đầy đủ.

## 33. Database roles

Không dùng superuser runtime. Bảy role tối thiểu:

```
rhinoq_owner            sở hữu schema
rhinoq_migrator         chỉ chạy migration
rhinoq_producer         chỉ EXECUTE rhinoq.enqueue()
rhinoq_agent            claim, lease, update state
rhinoq_verifier         chỉ SELECT trên allowlist (mục 38)
rhinoq_console_viewer   chỉ đọc
rhinoq_operator         retry/resume/repair
```

---

## 34. Producer và worker bị giới hạn

**Producer chỉ được `EXECUTE rhinoq.enqueue()`.** Không được: SELECT payload · UPDATE status · replay job · đọc job của tenant khác.

Nghĩa là API server bị compromise cũng không đọc được toàn bộ queue.

**Worker không trực tiếp sửa trạng thái job** — phải qua Agent với attempt token (mục 35).

---

## 35. Attempt token

Agent cấp token khi giao job:

```
{ jobId, attemptId, leaseOwner, expiresAt, nonce, signature }
```

Worker báo hoàn thành phải trả token hợp lệ.

**Ngăn được:** worker cũ (đã mất lease, bị coi là chết) báo `completed` sau khi lease đã chuyển cho worker khác — tình huống gây duplicate processing mà mọi queue dựa trên visibility timeout đều dính.

---

## 36. Console auth và RBAC

Production thiếu auth → **Console không mount** + security error rõ ràng trong log. **Application vẫn boot bình thường.**

```yaml
console:
  enabled: true
  required: false # mặc định — thiếu auth thì tắt Console, app vẫn chạy
```

Chỉ boot fail khi `required: true` — người dùng chủ động nói "Console là bắt buộc với tôi".

Lý do sửa: làm cả application chết vì thiếu cấu hình _dashboard_ là phản ứng quá mức. Job vẫn nên chạy; chỉ giao diện quan sát bị tắt. Không có chế độ "tạm thời bỏ auth" — chỉ có mount hoặc không mount.

```
viewer     xem
operator   retry · resume · verify · repair dry-run
approver   phê duyệt repair nhạy cảm    ← tách khỏi operator
admin      config · override
```

`approver` tách khỏi `operator` để một người không thể vừa đề xuất vừa duyệt repair nhạy cảm.

---

## 37. Payload classification

**Không mask chỉ bằng tên field** — tên field không đủ tin cậy.

Schema khai báo phân loại:

```
public            hiển thị bình thường
sensitive         mask mặc định, xem full phải có quyền + ghi audit
secret-reference  chỉ lưu reference, không lưu giá trị
never-persist     không bao giờ ghi xuống DB
```

**Token thật không được đi vào payload.** Dùng `secret-reference` trỏ tới secret manager.

---

## 38. Outcome DSL không chạy SQL tuỳ ý

Verifier chạy trong Agent (có quyền DB) **chỉ được** dùng primitive ở mục 11.7, với:

- Table/view allowlist
- Column allowlist
- Parameter binding (không string concat)
- Row limit
- Statement timeout
- Tenant filter bắt buộc

Custom verifier phức tạp → chạy trong application worker của người dùng, với quyền của họ, không phải quyền Agent.

---

## 39. Tenant isolation

Mọi record phải có `tenant_id`. Kết hợp năm lớp:

1. Authorization tầng API
2. Tenant filter bắt buộc ở mọi query
3. Role database không phải owner
4. RLS nếu phù hợp
5. **Cross-tenant security test** trong CI

---

## 40. Repair security và SSRF protection

**Repair nhạy cảm cần:** re-authentication · dry-run · approval hai người · maximum batch size · rate limit · immutable audit.

**External verifier chống SSRF:** domain allowlist · chặn loopback/private/link-local · kiểm tra redirect · timeout · response-size limit · TLS verify · **không chuyển Authorization header qua domain khác**.

---

## 40.1 Audit không thật sự immutable — nói đúng mức

Nếu audit nằm trong PostgreSQL do khách hàng quản lý, **database owner vẫn sửa hoặc xoá được**. Không được gọi nó là immutable.

**Nói đúng:** append-only _đối với runtime và operator role_. `rhinoq_agent` và `rhinoq_operator` chỉ có `INSERT`, không có `UPDATE`/`DELETE` trên `rhinoq.audit`.

Muốn tamper evidence thật thì cần thêm một trong ba:

```
hash chain           mỗi row chứa hash(row trước) → sửa giữa chừng là lộ
signed checkpoint    định kỳ ký root hash bằng key ngoài database
WORM export          đẩy sang object storage có object-lock
```

Hash chain là rẻ nhất và nên có từ v0.1:

```sql
prev_hash text NOT NULL,
row_hash  text NOT NULL   -- blake3(prev_hash || canonical(row))
```

## 40.2 Credential scoping cho handler

Handler không nên nhận toàn bộ secret của worker process. Một package npm độc hại trong dependency tree của handler sẽ đọc được tất cả.

```yaml
job: upload-video
secrets:
  s3:
    scope: "videos/{scanId}/*" # chỉ prefix này
    ttl: 15m # short-lived credential
  allowedEgress:
    - s3.ap-southeast-1.amazonaws.com
```

Ba nguyên tắc: secret scope **theo job** · short-lived credential (STS token, không phải static key) · domain/service allowlist cho egress.

## 40.3 Worker code isolation

Process isolation không chỉ phục vụ performance. Nó là ranh giới bảo mật — và phải định nghĩa rõ tám thứ:

```yaml
isolation:
  osUser: rhinoq-worker
  memoryLimit: 512MB
  cpuLimit: 1.0
  tmpDir: /var/tmp/rhinoq/{jobId} # xoá sau khi xong
  networkEgress: allowlist
  filesystemAccess: readonly-except-tmp
  secretAccess: scoped # mục 40.2
  maxLogBytes: 1MB
```

Mục tiêu: **một handler hoặc package độc hại không được đọc credential của Agent.** Agent giữ quyền database cao; handler thì không.

## 40.4 GDPR và data deletion

Payload, error log và correlation có thể chứa dữ liệu người dùng. Nếu không có đường xoá, RhinoQ trở thành rủi ro tuân thủ cho người dùng.

```bash
npx rhinoq privacy:erase --subject=user:USR-1928
```

Năm năng lực cần: delete/anonymize by subject · **payload crypto-shredding** (mã hoá payload bằng key riêng theo subject, xoá key là xoá dữ liệu — không cần rewrite partition) · retention theo data class · legal hold · audit exemption.

**Nhưng không được phá evidence cần cho audit.** Chính sách ba tầng:

```
delete    payload (chứa dữ liệu cá nhân)
anonymize correlation (giữ cấu trúc, thay business_id bằng token)
retain    execution evidence không định danh (thời điểm, kết quả, attempt count)
```

Crypto-shredding là kỹ thuật quan trọng nhất ở đây: xoá dữ liệu trong partition đã đóng bằng `DELETE` là việc rất đắt, còn xoá key thì tức thời.

---

# PHẦN VIII — KỸ THUẬT

## 41. Storage schema

```sql
CREATE SCHEMA IF NOT EXISTS rhinoq;
```

Không đụng `public` · `DROP SCHEMA rhinoq CASCADE` để bỏ sạch · `pg_dump --exclude-schema=rhinoq`.

### jobs (intent — hot state, cột hẹp)

```sql
-- HOT TABLE: KHÔNG partition. Bảng này bị claim liên tục.
-- Chỉ chứa job chưa terminal + terminal gần đây. Kích thước bị chặn bởi
-- workload đang chạy, KHÔNG tăng theo tổng lịch sử.
CREATE TABLE rhinoq.jobs_hot (
  id                 bigint      PRIMARY KEY,      -- từ global sequence
  tenant_id          text        NOT NULL,
  name               text        NOT NULL,
  payload_ref        text        NOT NULL,   -- inline hoặc blob hash (mục 30)

  -- BỐN CHIỀU TRẠNG THÁI — không nhồi vào một enum (mục 41.4)
  run_state          text        NOT NULL,
  -- pending|leased|succeeded|retry_wait|dead|cancelled|blocked
  verify_state       text        NOT NULL DEFAULT 'not_required',
  -- not_required|pending|achieved|mismatch|unverifiable|stale
  attention_state    text        NOT NULL DEFAULT 'none',
  -- none|effect_uncertain|dead_job|outcome_mismatch|repair_pending|cancel_failed
  recovery_state     text        NOT NULL DEFAULT 'none',
  -- none|retryable|resumable|repair_proposed|repairing|repaired

  priority           int         NOT NULL DEFAULT 0,
  resource_class     text        NOT NULL DEFAULT 'standard',
  integrity          text        NOT NULL DEFAULT 'execution',

  attempt_count      int         NOT NULL DEFAULT 0,
  max_attempts       int         NOT NULL DEFAULT 3,

  run_at             timestamptz NOT NULL DEFAULT now(),
  lease_owner        text,
  lease_expires_at   timestamptz,
  lease_epoch        bigint      NOT NULL DEFAULT 0,   -- fencing token (mục 41.3)

  cancel_requested_at timestamptz,
  crash_count        int         NOT NULL DEFAULT 0,   -- poison protection (mục 9.4)
  distinct_workers_failed int    NOT NULL DEFAULT 0,

  payload_version    int         NOT NULL DEFAULT 1,
  handler_version    text,
  outcome_contract_version int,

  outcome_status     text,        -- n/a|pending|achieved|mismatch|unverifiable|stale
  outcome_deadline   timestamptz,
  outcome_not_before timestamptz,
  outcome_next_check timestamptz,

  correlation_hash   text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- KHÔNG có PARTITION BY. KHÔNG có UNIQUE idempotency ở đây.

CREATE INDEX idx_hot_dequeue ON rhinoq.jobs_hot (name, priority DESC, run_at)
  WHERE run_state = 'pending';
CREATE INDEX idx_hot_lease ON rhinoq.jobs_hot (lease_expires_at)
  WHERE run_state = 'leased';
CREATE INDEX idx_hot_outcome ON rhinoq.jobs_hot (outcome_next_check)
  WHERE verify_state = 'pending';
CREATE INDEX idx_hot_attention ON rhinoq.jobs_hot (updated_at DESC)
  WHERE attention_state <> 'none';
```

### job_keys — global idempotency registry

Idempotency phải là **global**, không thể nằm trên bảng partition theo thời gian. Tách thành registry riêng, không partition:

```sql
CREATE TABLE rhinoq.job_keys (
  tenant_id      text   NOT NULL,
  idem_namespace text   NOT NULL,
  idem_key       text   NOT NULL,
  job_id         bigint NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idem_namespace, idem_key)
);
```

Enqueue là một transaction: `INSERT INTO job_keys` (trúng conflict → trả job cũ) rồi `INSERT INTO jobs_hot`. **Deduplication horizon phải khai báo, không mặc định ngầm:**

```ts
idempotency: {
  namespace: 'scan',
  key: scanId,
  horizon: 'forever' | 'until-terminal' | '30d',
}
```

| Horizon          | Dùng cho              | Rủi ro nếu chọn sai         |
| ---------------- | --------------------- | --------------------------- |
| `forever`        | payment, ledger entry | registry tăng vô hạn        |
| `until-terminal` | thumbnail, cache warm | job cũ có thể enqueue lại   |
| `30d`, `24h`…    | report generation     | enqueue lại sau khi hết hạn |

Không có horizon thì chỉ có hai kết cục: registry tăng vô hạn, **hoặc** cleanup làm job cũ được enqueue lại ngoài ý muốn. Cả hai đều tệ, nên đây phải là quyết định có ý thức của người dùng — RhinoQ mặc định `until-terminal` và **cảnh báo** nếu profile là `payment` mà horizon không phải `forever`.

### Bảng lịch sử — partition theo thời gian

```sql
rhinoq.attempts    PARTITION BY RANGE (started_at)     -- append-only (mục 44)
rhinoq.events      PARTITION BY RANGE (occurred_at)    -- timeline, progress, log
rhinoq.history     PARTITION BY RANGE (completed_at)   -- job đã rời hot table
rhinoq.capsules    PARTITION BY RANGE (completed_at)   -- evidence capsule (mục 29)
```

### Bảng phụ trợ — không partition

```sql
rhinoq.effects            -- pending|confirmed|uncertain|not_happened
rhinoq.correlations       -- (job_id, type, business_id) + index tra cứu
rhinoq.payload_blobs      -- content-addressed (mục 30.1)
rhinoq.error_fingerprints
rhinoq.schedules
rhinoq.repair_plans       -- state hash, expiry, expected changes (mục 13.5)
rhinoq.audit              -- append-only + hash chain (mục 40.1)
rhinoq.config
rhinoq.migrations
```

### 41.3 `lease_epoch` — fencing token

Attempt token (mục 35) có `nonce` và `signature`, nhưng nếu database không có **fencing counter** thì worker cũ vẫn cập nhật được state sau khi job đã giao cho worker mới.

Mỗi lần claim: `lease_epoch = lease_epoch + 1`.

**Mọi** thao tác sau đó phải kiểm epoch:

```sql
UPDATE rhinoq.jobs_hot
SET run_state = 'succeeded'
WHERE id = $jobId
  AND lease_owner = $workerId
  AND lease_epoch = $epoch;
-- 0 row affected → worker này đã mất lease, DỪNG LẠI
```

Áp dụng cho **cả bảy**: heartbeat · complete · fail · begin effect · confirm effect · progress · checkpoint.

Bỏ sót một cái là mở lại đúng lỗ hổng mà attempt token định bịt. Đặc biệt `begin effect` — worker cũ mở effect sau khi mất lease là kịch bản tệ nhất.

### 41.4 Vì sao tách bốn cột trạng thái

Một cột `status` duy nhất trộn bốn chiều khác nhau: execution · verification · operational attention · recovery. Hệ quả là có những trạng thái **không biểu diễn được**:

```
Execution succeeded + Effect uncertain + Outcome unverifiable + Repair pending
```

Bốn sự thật đồng thời, một enum không chứa nổi.

```
run_state       pending | leased | succeeded | retry_wait | dead | cancelled | blocked
verify_state    not_required | pending | achieved | mismatch | unverifiable | stale
attention_state none | effect_uncertain | dead_job | outcome_mismatch | repair_pending | cancel_failed
recovery_state  none | retryable | resumable | repair_proposed | repairing | repaired
```

Console **derive** một nhãn tổng hợp để hiển thị (ví dụ "Needs decision"), nhưng database không ép bốn chiều vào một enum. Derive được; ép vào rồi thì không tách ra được nữa.

### 41.1 Vòng đời một job qua các bảng

```
enqueue    → job_keys (idempotency) + jobs_hot
chạy       → attempts (partition) + events (partition)
terminal   → ở lại jobs_hot một thời gian ngắn (để Console tra nhanh)
sau đó     → chuyển sang history (partition), xoá khỏi jobs_hot
hết hạn    → compact thành capsules, drop partition của attempts/events
```

**Sweeper** chạy định kỳ chuyển job terminal từ `jobs_hot` sang `history`, theo batch nhỏ, thuộc resource class `maintenance` (pause đầu tiên khi DB chịu tải).

**Phải là một transaction duy nhất.** Nếu DELETE xong rồi INSERT lỗi, job history mất vĩnh viễn:

```sql
-- ĐÚNG: một statement, atomic
WITH moved AS (
  DELETE FROM rhinoq.jobs_hot
  WHERE run_state IN ('succeeded','dead','cancelled')
    AND updated_at < now() - interval '1 hour'
  LIMIT 500
  RETURNING *
)
INSERT INTO rhinoq.history SELECT * FROM moved;
```

Cách thay thế cũng an toàn: INSERT trước với `job_id` là primary key (idempotent nếu chạy lại), rồi DELETE. Crash giữa hai bước chỉ để lại bản sao thừa, không mất dữ liệu.

Test crash ở **từng điểm** trong sweeper là một mục bắt buộc của reliability test (mục 47).

### 41.2 Nguyên tắc

> **Không partition bảng đang được claim liên tục. Chỉ partition dữ liệu lịch sử.**

Ba lý do:

1. **Unique constraint.** Postgres bắt buộc unique constraint trên partitioned table phải chứa partition key. Idempotency `(tenant, namespace, key)` không chứa `created_at` → **không tạo được**. Đây là lỗi khiến schema không compile, không phải vấn đề hiệu năng.
2. **Claim phải quét nhiều partition.** Job pending có thể nằm ở partition tháng trước (delayed job, job bị retry lâu) → planner phải chạm nhiều partition cho mọi lần claim.
3. **`FOR UPDATE SKIP LOCKED` qua partition** phức tạp hơn và khó dự đoán hơn trên một bảng phẳng.

Đổi lại, `jobs_hot` phải được **giữ nhỏ bằng sweeper**, không phải bằng partition. Kích thước của nó bị chặn bởi _workload đang chạy_, không tăng theo tổng lịch sử — đúng lời hứa ở mục 29.

---

## 42. Dequeue và lease

```sql
UPDATE rhinoq.jobs_hot
SET run_state = 'leased', lease_owner = $1,
    lease_expires_at = now() + ($2 || ' ms')::interval,   -- DB time là authority (mục 50.3)
    lease_epoch = lease_epoch + 1,                        -- fencing (mục 41.3)
    attempt_count = attempt_count + 1, updated_at = now()
WHERE id IN (
  SELECT id FROM rhinoq.jobs_hot
  WHERE run_state = 'pending' AND name = ANY($3) AND run_at <= now()
    AND tenant_id = $5
  ORDER BY priority DESC, run_at
  LIMIT $4          -- = available_slots × prefetch_factor (mục 26)
  FOR UPDATE SKIP LOCKED
)
RETURNING *, lease_epoch, lease_expires_at;   -- worker nhận epoch + hạn từ DB
```

**Reaper — chỗ RUN và VERIFY gặp nhau, logic quan trọng nhất hệ thống:**

```
Mỗi 30 giây, với job trong jobs_hot có run_state='leased' AND lease_expires_at < now():
  1. Ghi attempt.result = 'lost'
  2. Effect đang 'pending' → 'uncertain'
  3. Quyết định:
     · effect uncertain + irreversible + không verify → 'needs_decision'
     · effect uncertain + có verify                  → gọi verify
     · không có effect → 'pending' (retry) hoặc 'dead'
```

**Lease phải gia hạn được** — job dài gọi `ctx.heartbeat()`. Lease ngắn hơn thời gian xử lý thật → hai worker cùng chạy một job. RhinoQ tự phát hiện cấu hình sai này và cảnh báo:

```
⚠ Job p99 duration 93s · lease 60s → nguy cơ xử lý trùng.
  Đề xuất: lease ≥ 180s hoặc dùng ctx.heartbeat()
```

---

## 43. Namespaced idempotency

```ts
idempotency: { namespace: 'scan', key: scanId }
```

DB: bảng `rhinoq.job_keys` với `PRIMARY KEY (tenant_id, idem_namespace, idem_key)` — **bảng riêng, không partition** (mục 41). Đây là lý do idempotency không thể nằm trong `jobs_hot` nếu bảng đó bị partition.

| Mức           | Ví dụ                   | Dùng khi                             |
| ------------- | ----------------------- | ------------------------------------ |
| Job name      | `settle-scan-credit`    | mặc định                             |
| Business type | `scan`                  | nhiều job cùng chống trùng theo scan |
| Tenant + type | tự động qua `tenant_id` | multi-tenant, bắt buộc               |

```ts
onConflict: "ignore"; // trả job cũ (mặc định)
onConflict: "error"; // throw
onConflict: "replace"; // chỉ khi job cũ chưa active — BỊ CHẶN nếu đã có effect confirmed
```

---

## 44. Append-only attempts

Mỗi lần thử là một row mới, không UPDATE row cũ.

**Vì sao bắt buộc:** timeline cần biết attempt 1 fail vì gì, attempt 2 vì gì · effect gắn với attempt cụ thể · handler versioning cần biết attempt nào chạy version nào · audit cần bằng chứng không sửa được.

Không có append-only thì VERIFY và RECOVER không thể tồn tại.

**Chi phí:** retry storm làm `attempts` phình nhanh → bắt buộc partition từ ngày đầu (mục 41) + error fingerprint (mục 31) + circuit breaker (mục 28).

---

## 45. Ba deployment mode

Câu người dùng sẽ hỏi nhiều nhất: **"queue backlog có làm API của tôi chết theo không?"** Câu trả lời phụ thuộc deployment mode, và phải nói thẳng cả ba.

| Mode                         | Atomic enqueue                          | Cô lập tải   | Dùng khi                                                   |
| ---------------------------- | --------------------------------------- | ------------ | ---------------------------------------------------------- |
| **Embedded** — cùng database | **Mạnh nhất** (`{ tx }` thật)           | Thấp         | app vừa và nhỏ, workload có business invariant             |
| **Same cluster, DB riêng**   | Hạn chế — qua outbox trong DB nghiệp vụ | Trung bình   | DB chính đã chịu áp lực, nhưng vẫn muốn latency thấp       |
| **PostgreSQL riêng**         | Qua outbox (mục 54)                     | **Cao nhất** | workload lớn, DBA không cho tạo schema, cần tách hoàn toàn |

### 45.1 Embedded mode — hard budget bắt buộc

Đây là mode mặc định và là chỗ rủi ro nhất. Không có budget thì RhinoQ trở thành nguồn sự cố cho chính app nó phục vụ.

```yaml
database:
  maxConnections: 5
  maxClaimBatch: 20 # chặt hơn mặc định 50 — dùng chung DB với API
  maxStatementTime: 2s
  maxVerifierConcurrency: 2
  maxReconcileConcurrency: 1
```

`maxClaimBatch` ở embedded mode nên chặt hơn hai mode kia, vì mỗi lần claim là một lock trên database đang phục vụ request của người dùng. Đây vẫn là **hard cap**, không phải batch size mục tiêu — claim thực tế luôn tính từ slot còn trống (mục 26).

> **RhinoQ không được "tự thông minh" rồi vượt giới hạn.** Adaptive concurrency (mục 26) chỉ được điều chỉnh _trong_ budget, không bao giờ vượt qua. Nếu adaptive logic tính ra cần 30 connection mà budget là 5, nó dùng 5 và ghi cảnh báo — không tự nới.

### 45.2 Mode 2 và 3 — mất gì

Ở hai mode sau, `{ tx }` không còn là transaction thật giữa business data và job. Thay bằng outbox local:

```
business transaction + local outbox row → cùng commit  ✓ atomic (trong DB nghiệp vụ)
outbox → RhinoQ                          → at-least-once
materialize                              → idempotent theo intentId
```

Console phải hiện cảnh báo thường trực:

```
⚠ Mode: separate-database — transactional enqueue qua outbox.
  Đảm bảo: local atomic intent + at-least-once transfer + idempotent materialization.
  KHÔNG phải distributed exactly-once.
```

RUN, VERIFY, RECOVER hoạt động đầy đủ ở cả ba mode. Chỉ COMMIT thay đổi tính chất.

### 45.3 Vì sao cần mode 2 và 3

DBA không cho tạo schema trong DB nghiệp vụ (rào cản adoption rất thật) · DB chính đã chịu áp lực · muốn tách workload · muốn thử RhinoQ mà không chạm production DB.

Không nên biến lợi thế chính (embedded) thành giới hạn cứng làm giảm adoption.

---

## 46. Migration schema

```ts
autoMigrate: process.env.NODE_ENV !== "production";
```

```bash
npx rhinoq migrate:generate > migrations/001_rhinoq.sql
```

> **RhinoQ không tự sửa DB của bạn ở production. Nó chỉ đưa SQL.**

**Nhiều instance boot cùng lúc:** `pg_advisory_lock(748291)` — một chạy, các instance khác chờ.

**Version mismatch:** DB cũ hơn → production throw rõ ràng. DB mới hơn → cảnh báo và **không chạy tiếp**.

> **Quy tắc bất di bất dịch: migration chỉ THÊM, không bao giờ xoá hay đổi tên column.** Rolling deploy có v1 và v2 song song vài phút, cả hai phải đọc được cùng schema.

---

# PHẦN IX — TESTING VÀ RELEASE GATE

## 47. Bốn tầng test

RhinoQ không được làm mọi lần chạy test trở nên nặng.

| Tầng            | Cần Postgres/Agent? | Kiểm tra                                                                                                                                          |
| --------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit**        | không               | handler logic · outcome rule · repair calculation · retry policy                                                                                  |
| **Contract**    | không               | payment job có idempotency? outcome có deadline? payload có secret? query field có index? effect irreversible có policy?                          |
| **Integration** | có                  | `enqueue → runUntilIdle → assert state`                                                                                                           |
| **Reliability** | có, nightly         | kill worker · mất DB connection · lease expiry · retry storm · Postgres restart · old/new worker version · effect uncertainty · storage threshold |

**Virtual clock** — không chờ thật 15 phút:

```ts
await advanceTime("15m");
await runUntilIdle();
expect(job.outcomeStatus).toBe("missed");
```

Tầng **Contract test** là thứ ít queue nào có, và nó bắt lỗi cấu hình _trước khi_ lên production — rẻ hơn nhiều so với phát hiện lúc 2 giờ sáng.

---

## 48. `rhinoq verify`

Chạy trên hạ tầng của chính người dùng. Đừng bắt họ tin README.

```
RhinoQ Production Verification
Postgres 16.2 · 4 vCPU · pool 5

COMMIT
✓ Transaction rollback không tạo job
✓ Intent đã commit sống sót qua process crash
✓ Namespaced idempotency chặn trùng qua 8 worker
✓ Payload > 256KB bị từ chối ở producer

RUN
✓ Batch claim đúng, không duplicate qua 8 worker
✓ Orphaned job recover sau kill -9
✓ Lease gia hạn đúng khi heartbeat
✓ Attempt token chặn worker cũ báo completed
✓ Scheduler chạy đúng 1 lần trên 4 instance

VERIFY
✓ Effect pending → uncertain khi worker chết
✓ KHÔNG auto-retry effect irreversible không verify
✓ Outcome deadline quá hạn → missed + alert

RECOVER
✓ Repair dry-run không thay đổi dữ liệu
✓ Effect confirmed không bị gọi lại khi resume
✓ Audit ghi đầy đủ

SECURITY
✓ Runtime không dùng superuser
✓ Producer role không SELECT được payload
✓ Console không mount khi thiếu auth
✗ Cross-tenant test: 1 query thiếu tenant filter   ← FAIL

STORAGE
✓ Partition drop < 200ms
✓ Retention chạy đúng

Kết luận: KHÔNG production-ready. Sửa lỗi security ở trên trước.
```

---

## 49. Benchmark gate

Không được gọi production-ready nếu chưa đo đủ năm nhóm:

**API impact** — enqueue p50/p95/p99 · business endpoint trước/sau RhinoQ · commit latency · connection wait
**Queue engine** — claim p99 · throughput theo payload size · 1–32 worker · delayed job latency · lease recovery time
**Database** — WAL/job · IOPS · CPU · autovacuum · table/index bloat · replication lag · 1M/10M/100M history
**Integrity** — effect write overhead · outcome batch overhead · reconciliation cost · retry storm behavior
**Storage** — compaction ratio · partition drop time · payload compression · storage threshold behavior

Mục tiêu quan trọng nhất — và là câu người dùng thật sự quan tâm:

> **RhinoQ phải chứng minh nó không vượt resource budget mà người dùng đã cấu hình.**

Công bố **cả trường hợp RhinoQ chậm hơn BullMQ**. Thừa nhận điểm yếu làm tăng độ tin cậy hơn là che.

---

## 50. Security gate

Không phát hành production nếu thiếu bất kỳ mục nào:

- [ ] Runtime không dùng superuser
- [ ] Separate database roles
- [ ] Console auth bắt buộc
- [ ] RBAC (viewer/operator/approver/admin)
- [ ] Tenant authorization
- [ ] Payload redaction **trước khi ghi**
- [ ] Secret reference (token thật không vào payload)
- [ ] Secure enqueue function
- [ ] Attempt token
- [ ] No arbitrary SQL
- [ ] Statement timeout
- [ ] Repair audit
- [ ] Repair approval cho workload nhạy cảm
- [ ] TLS/mTLS khi chạy qua network
- [ ] SSRF protection
- [ ] CSRF và stored-XSS protection ở Console
- [ ] Dependency scan
- [ ] Migration integrity
- [ ] Cross-tenant tests
- [ ] Security documentation

---

## 50.1 Bằng chứng production — không thể thay bằng README dài

RhinoQ hiện mới có **thiết kế**. BullMQ có mental model quen thuộc, hàng năm battle-test, và tích hợp NestJS chính thức. Không ai đổi hạ tầng vì một tài liệu hay.

Bảy thứ phải công bố trước khi nói "production-ready":

| Bằng chứng                  | Nội dung                                                                                                           | Vì sao cần                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| **Fault-test logs**         | log thật của `kill -9` giữa lúc chạy, mất DB connection, lease expiry, Postgres restart — có timestamp, có kết quả | chứng minh crash recovery không phải lý thuyết |
| **Reproducible benchmarks** | script + hardware spec + workload, ai cũng chạy lại được                                                           | benchmark không tái hiện được là marketing     |
| **Known limitations**       | danh sách thẳng thắn cái chưa làm được                                                                             | mục 6 + mục 10.7                               |
| **Failure semantics table** | mục 10.7                                                                                                           | người ta cần biết chính xác được đảm bảo gì    |
| **Migration guide**         | mục 51–52, có checklist và rollback                                                                                |                                                |
| **Database impact report**  | latency API trước/sau, WAL/job, connection usage ở mỗi mode                                                        | trả lời câu hỏi lớn nhất (mục 45)              |
| **Case study thật**         | ít nhất một hệ thống production dùng thật, có số liệu                                                              | thứ khó nhất và giá trị nhất                   |

Case study đầu tiên nhiều khả năng phải là **hệ thống của chính bạn**. Đó là lý do mục 60 hỏi _"bạn có thật sự đau vì cái này không"_ — nếu bạn không có workload thật để chạy RhinoQ, bạn không có case study, và không có case study thì bảy mục trên chỉ còn sáu.

---

# PHẦN IX-B — RUNTIME SEMANTICS

Bốn mục này trả lời các câu hỏi vận hành mà mọi hệ thống phân tán phải trả lời được, và thiếu chúng thì `rhinoq verify` không có gì để kiểm.

## 50.2 Database outage semantics

Khi PostgreSQL mất kết nối, phải nói rõ điều gì xảy ra:

| Câu hỏi                                            | Câu trả lời                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Worker đang chạy tiếp hay abort?                   | **Tiếp tục** với job không có irreversible effect. **Dừng** ngay với job đang có effect `pending`                   |
| Heartbeat fail bao lâu thì dừng handler?           | quá `leaseRenewGrace` (mặc định = 1/3 lease duration) → gửi `abortSignal`                                           |
| Complete không ghi được thì sao?                   | buffer local, retry ghi trong `completeRetryWindow`; hết window → **coi như mất lease**, không tự cho là thành công |
| Có buffer local không?                             | có, cho progress/log (mất được). **Không** buffer cho effect state                                                  |
| Có được tiếp tục external effect khi mất DB không? | **Không**                                                                                                           |

> **Quy tắc:** trước khi bắt đầu một irreversible effect, worker phải có kết nối authority hợp lệ (lease còn hạn, epoch đúng, DB reachable). Nếu mất DB **trong lúc** effect đang chạy, effect chuyển `uncertain` khi hệ thống phục hồi — không đoán.

Đây là lý do `begin effect` phải kiểm `lease_epoch` (mục 41.3): nó là điểm duy nhất RhinoQ có thể chặn trước khi tiền thật bị tiêu.

## 50.3 Clock semantics

Không dùng clock của application cho lease và scheduling. Clock skew giữa worker làm job hết lease sớm hoặc scheduler chạy sai giờ.

```
DB time (now()) là authority cho:   run_at · lease expiry · schedule · outcome deadline
Worker local time chỉ dùng cho:     telemetry · log timestamp · đo duration nội bộ
```

Worker không tự tính `lease_expires_at` rồi gửi lên. Nó nhận giá trị **DB đã tính** trong `RETURNING` của câu claim. Mọi so sánh thời gian xảy ra trong SQL, không trong application code.

`rhinoq doctor` nên cảnh báo nếu phát hiện skew > 5s giữa worker và DB.

## 50.4 Backup và restore semantics

Restore PostgreSQL về snapshot cũ → RhinoQ state quay ngược, **external effect không quay ngược**. Restore Guard đầy đủ để sau, nhưng baseline phải có ngay:

```
1. Restore đưa system vào SAFE MODE (không tự claim job)
2. Tạm dừng mọi job có irreversible effect
3. Đánh dấu effect trong khoảng thời gian bị mất là "có khả năng inconsistent"
4. Chạy reconciliation trước khi resume
5. KHÔNG tự replay history sau restore
```

Bước 5 quan trọng nhất: sau restore, job đã `succeeded` có thể quay lại `pending`. Tự động chạy lại chúng nghĩa là chạy lại toàn bộ effect của khoảng thời gian đó.

Phát hiện restore bằng cách so sequence hiện tại với checkpoint gần nhất — nếu `max(job_id)` **giảm**, đó là dấu hiệu restore.

## 50.5 Readiness và liveness

Không dùng một `/health` trả 200 cho mọi thứ — orchestrator sẽ không biết khi nào nên restart và khi nào nên ngừng gửi traffic.

```
GET /health/live    → process còn sống (chỉ vậy)

GET /health/ready   → DB reachable
                      migration version khớp
                      worker có thể claim
                      queue không bị pause toàn cục
                      security config hợp lệ
```

Liveness fail → restart pod. Readiness fail → **không** restart, chỉ ngừng đưa vào rotation. Gộp hai cái làm một dẫn tới restart loop khi database chỉ tạm chậm.

---

# PHẦN X — MIGRATION TỪ BULLMQ

## 51. Bốn công cụ, không phải một suite

**Migration tool là đường vào sản phẩm, không phải sản phẩm chính.** Giai đoạn đầu chỉ làm bốn thứ:

### Analyze

```bash
npx rhinoq analyze --bullmq
```

Xác định queue nào phù hợp chuyển — và **tự loại những queue không nên chuyển** (throughput cao, dùng Flows, dùng group rate limiter). Việc tự loại tạo niềm tin nhiều hơn là nói mình làm được mọi thứ.

### Observer (chỉ đọc, không sửa gì)

Tìm bốn thứ trong hệ thống hiện tại: missing job · duplicate processing · **completed nhưng business state sai** · job không còn history.

> RhinoQ không nói "tôi tốt hơn". Nó chỉ ra lỗi đang tồn tại trong hệ thống của họ, bằng dữ liệu của chính họ. Không ai tranh luận với số liệu trên production của mình.

**Giới hạn phải nói thẳng:** BullMQ events nằm trên Redis stream, mất khi Redis restart. Observer cho _dấu hiệu_, không cho bằng chứng đầy đủ.

### Protect Intent

Producer ghi local intent trong transaction, worker BullMQ **vẫn chạy không sửa gì**. Chặn dual-write ngay mà không đụng tới worker.

### Drain Status

Kiểm bốn tập trước khi tắt worker: waiting · active · **delayed** · **repeat**.

### Hoãn — không làm ở giai đoạn đầu

Compat API đầy đủ · codemod hoàn chỉnh · shadow full execution · import/export mọi loại job · bridge hai chiều · automatic rollback.

---

## 52. Drain và cutover

**Không tắt BullMQ worker ngay khi đổi producer** — job pending trong Redis sẽ không ai xử lý.

```
PHA 1 — STOP PRODUCING
  Producer đổi sang rhinoq.enqueue()
  BullMQ worker VẪN CHẠY, xử lý hết job còn lại
  → Hai worker chạy song song, hai tập job KHÁC NHAU. Không trùng, không mất.

PHA 2 — DRAIN COMPLETE
  npx rhinoq drain-status → waiting 0 · active 0 · delayed 0 · repeat 0
  → An toàn tắt BullMQ worker
```

**Ba cái bẫy:** delayed job có thể nằm trong Redis hàng tuần · repeatable job tự sinh job mới mãi (phải `removeRepeatable()` trước) · active job lúc kill worker sẽ stalled (cần graceful shutdown).

**Rollback trong 1 phút** ở mọi bước trước khi xoá BullMQ. Bước xoá BullMQ là điểm không quay lại — đừng làm cho tới khi chạy ổn 14 ngày.

---

# PHẦN XI — ĐA NGÔN NGỮ VÀ DATABASE

## 53. Agent, Protocol, SDK

RhinoQ không nên bị khoá vào Node.js. Kiến trúc dài hạn:

```
Application (Node · Go · Python · Java · .NET)
      │  Thin SDK
      ▼  Unix socket / gRPC
RhinoQ Agent    ← toàn bộ correctness
      │
      ▼
PostgreSQL
```

**Agent chứa:** claim · lease · retry · scheduler · storage · resource governor · compaction · security.
**SDK chỉ làm bốn việc:** enqueue · register handler · receive job · report result/effect.

Lý do: nếu SDK Node xử lý lease một kiểu, SDK Python một kiểu khác, SDK Java có bug crash-recovery riêng — correctness bị nhân theo số ngôn ngữ. Gom vào một Agent là cách duy nhất giữ đúng lời hứa khi có nhiều SDK.

**SQL enqueue function** cho phép mọi ORM dùng được ngay, kể cả trước khi có SDK riêng:

```sql
BEGIN;
INSERT INTO scans (...) VALUES (...);
SELECT rhinoq.enqueue('settle-scan-credit', '{"scanId":"SCAN-9218"}'::jsonb, 'scan:SCAN-9218');
COMMIT;
```

### 53.1 Protocol version negotiation

Không dựa vào package version. Agent và SDK phải bắt tay rõ ràng:

```json
{
  "protocolVersion": "1.2",
  "capabilities": ["effect.v2", "cancel", "checkpoint", "batch-claim"],
  "payloadCodec": "json|msgpack",
  "compression": "zstd|none",
  "maxMessageSize": 4194304,
  "heartbeatInterval": 10000,
  "effectProtocolVersion": 2
}
```

Ba kết quả, phải phân biệt rõ:

| Kết quả      | Nghĩa                          | Hành vi                                                                                               |
| ------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `compatible` | đủ capability                  | chạy bình thường                                                                                      |
| `degraded`   | thiếu capability không cốt lõi | chạy, **log rõ cái gì bị tắt** (ví dụ: SDK cũ không có `cancel` → cancel chỉ cooperative qua timeout) |
| `rejected`   | thiếu capability cốt lõi       | từ chối kết nối, error nói rõ cần nâng cấp cái gì                                                     |

`degraded` phải hiện trong Console — người vận hành cần biết một worker đang chạy ở chế độ thiếu tính năng.

### 53.2 Language-neutral error model

Node error, Python exception, Go error và Java exception có cấu trúc khác nhau. Không có envelope chung thì retry policy và error fingerprint sẽ khác nhau theo SDK — cùng một lỗi ở hai ngôn ngữ cho hai fingerprint khác nhau, và circuit breaker không gom được.

```json
{
  "type": "DependencyUnavailable",
  "retryClass": "transient",
  "message": "connection refused to provider-a",
  "fingerprint": "blake3:9f2c...",
  "details": { "provider": "provider-a", "statusCode": 503 },
  "stack": "...",
  "language": "python"
}
```

`retryClass` map thẳng vào mục 9.2. SDK chịu trách nhiệm dịch exception bản địa sang envelope này; **Agent chỉ hiểu envelope**, không parse stack trace theo ngôn ngữ.

### 53.3 SQL enqueue function cần auth và schema contract

Cho mọi ngôn ngữ enqueue qua SQL là tốt, nhưng **không được** để:

```sql
-- ❌ producer role chung + tên job tuỳ ý + JSON tuỳ ý
rhinoq.enqueue(any_name, any_json)
```

Function phải kiểm bảy thứ:

```sql
rhinoq.enqueue(
  job_name        => 'settle-scan-credit',  -- phải nằm trong job allowlist
  tenant_id       => current_setting('app.tenant_id'),  -- BẮT BUỘC
  payload         => $1,
  payload_schema  => 'settle-scan-credit:v3',           -- schema ID + version
  idempotency_key => $2,
  idem_horizon    => 'until-terminal',
  correlation     => $3                                  -- validate type/format
);
```

`payload` vượt `maxPayloadBytes` → từ chối ngay trong function, không để vào bảng.

**Permission theo job name:** role `rhinoq_producer_payments` chỉ enqueue được job trong nhóm payment. Một service bị compromise không enqueue được job của domain khác.

**Thứ tự triển khai:** 1) Node SDK → 2) Protocol ổn định → 3) Go SDK → 4) Python SDK → 5) Java/.NET nếu có nhu cầu.

> **Không viết năm SDK trước khi Node runtime ổn định.** Và không thêm SDK thứ hai nếu chưa có người khác cam kết maintain nó — chi phí maintain tăng theo _số ngôn ngữ_, không theo số tính năng.

---

## 54. Intent Bridge cho database khác

Không cần nói MongoDB/SQL Server/MySQL "không dùng được".

```
business transaction + local intent outbox → cùng commit
                    ↓
Agent đọc outbox (CDC hoặc cursor)
                    ↓
materialize idempotently sang RhinoQ Postgres
```

Người dùng vẫn có: durable execution · effect · outcome · reconciliation · Console.

**Nhưng đảm bảo thật phải nói rõ:**

```
local atomic intent  +  at-least-once transfer  +  idempotent materialization
```

> ⚠ **Không được gọi là distributed exactly-once**, và **không phải cùng mức đảm bảo với transactional mode trên Postgres**. Mọi nơi nhắc tới Intent Bridge (docs, landing page, Console) phải hiện rõ nhãn này, không chỉ ở phần kỹ thuật sâu.

**Ưu tiên:** Postgres native → SQL Server Bridge → MongoDB Bridge → MySQL Bridge → chỉ viết native storage engine thứ hai khi có nhu cầu đủ lớn từ người dùng thật.

---

# PHẦN XII — THỰC THI

## 55. Scope v0.1

**24 mục. Không Reconciliation Engine đầy đủ, không Outcome Level 2, không migration suite.**

### COMMIT

1. PostgreSQL schema (partition từ ngày đầu)
2. Transactional enqueue
3. Namespaced idempotency
4. Business correlation
5. Payload validation + size limit

### RUN

6. Batch claim
7. Lease + heartbeat
8. Retry + exponential backoff + jitter
9. DLQ
10. Crash recovery
11. Basic delayed job
    11b. **Parity tối thiểu với BullMQ (mục 9.1)** — graceful shutdown 6 bước · pause/resume queue · rate limiting per-queue · worker process riêng · metrics export · NestJS module
    11c. **Retry classification (mục 9.2)** — 7 class, không retry mù mọi exception
    11d. **Cancellation cơ bản (mục 9.3)** — `abortSignal` cooperative + `cancel_requested`
    11e. **Poison-job protection (mục 9.4)** — `maxWorkerCrashesPerJob`
    11f. **`lease_epoch` fencing (mục 41.3)** — kiểm ở cả 7 thao tác
    11g. **Admission control (mục 28.2)** — `maxPendingJobs` + `criticalReservedSlots`

### VERIFY

12. **Effect tối giản** — `pending` · `confirmed` · `uncertain` · effect irreversible **không auto-retry** · `UNIQUE (job_id, effect_name, effect_key)` (mục 10.3c)
13. **Outcome Level 1 tối giản** — signal hoặc một indexed verifier · `deadline` · `notBefore` · `finality: 'once'` · 5 trạng thái (mục 11.5)
    13b. **Query-cost gate** (mục 11.6e) — `outcome:explain` chặn contract thiếu index ở CI

### RECOVER

14. Needs Attention list
15. Retry hoặc manual decision
16. Audit
17. Business search theo correlation

### DEVELOPER EXPERIENCE (không phải "làm sau")

17a. **`rhinoq init` chỉ tạo plan**, cần `--apply` (mục 14) — quyết định về niềm tin, không phải tiện lợi
17.1. **`rhinoq dev`** — một lệnh chạy app + worker + Console local, với app command được cấu hình
17c. **`defineJob` là canonical API duy nhất** (mục 16.1) — không có hệ cấu hình song song
17d. **`ctx.effect.run()` là mặc định** (mục 16.4) — API thủ công quá dễ quên `confirm()`
17e. **Ba trang docs tách biệt** (mục 16.2): Simple → Transactional → Protected
17.2. **Error message năm phần** + `rhinoq doctor` (mục 17.2)
17g. **Màn hình Queues** trong Console (mục 21) — thiếu là người dùng phải cài dashboard khác

### INFRASTRUCTURE BẮT BUỘC

18. Hard connection budget + admission control
19. Partition cho `attempts`/`events` (KHÔNG partition `jobs_hot`) + sweeper trong **một transaction** (mục 41.1)
20. Retention + idempotency horizon (mục 41)
21. Console auth (không mount nếu thiếu — app vẫn boot, mục 36)
22. Database role separation + `lease_epoch` fencing
23. Unit/integration/reliability test harness (có test crash ở từng điểm của sweeper)
24. Benchmark harness
25. **Clock authority = DB time** (mục 50.3) — quyết định sớm, sửa sau rất khó
26. **`/health/live` + `/health/ready` tách riêng** (mục 50.5)
27. **Audit hash chain** (mục 40.1) — thêm sau khi đã có dữ liệu thì phải rewrite toàn bộ

Mục 11b không phải "thêm việc" — nó là **điều kiện để người dùng thử nghiêm túc**. Thiếu graceful shutdown thì mỗi lần deploy tạo một loạt job orphaned, và người ta kết luận RhinoQ không đáng tin trước khi kịp thấy Effect hay Outcome.

**Mục 12 là giá trị lớn nhất với chi phí thấp nhất** — vài trăm dòng code, và cho ngay câu bán hàng mạnh nhất:

> Worker chết giữa lúc charge thẻ? RhinoQ không retry mù. Nó dừng lại và hỏi bạn.

---

## 56. Roadmap

| Version                              | Nội dung                                                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **v0.1 — Reliable Queue Foundation** | COMMIT · RUN · effect uncertainty tối giản · minimal Console · security baseline · bounded storage · resource budget · verify/doctor cơ bản   |
| **v0.2 — Business Integrity**        | Outcome Level 2 · invariant DSL · signal-first verification · batch verifier · business mismatch UI · handler versioning                      |
| **v0.3 — Safe Recovery**             | Resume · repair dry-run · approval · audit đầy đủ · incremental reconciliation                                                                |
| **v0.4 — Adoption**                  | BullMQ Analyze · Observer · Protect Intent · Drain Status · migration docs                                                                    |
| **v0.5 — Runtime Intelligence**      | adaptive concurrency · circuit breaker · fair scheduling · error fingerprint · storage circuit breaker                                        |
| **v0.6 — Polyglot**                  | stable protocol · Go SDK · Python SDK · Agent binary độc lập                                                                                  |
| **Sau khi có nhu cầu thật**          | SQL Server/MongoDB Intent Bridge · Restore Guard · advanced incident workspace · native storage engine thứ hai · DAG · advanced rate limiting |

**Quy tắc tự áp:** không viết dòng code nào cho v0.2 trước khi v0.1 đã publish lên npm và có ít nhất 3 người dùng ngoài bạn.

---

## 57. Loại bỏ và hạ cấp

### Loại khỏi RhinoQ Core

Integrity Score · generic APM · generic incident management · 20 adapter nhà cung cấp · workflow visual builder · DAG/Flows sớm · SaaS control plane · arbitrary SQL verifier · automatic repair không giới hạn.

### Hạ cấp thành later / enterprise

Restore Guard · cross-region control · advanced incident workspace · approval workflow phức tạp · full BullMQ migration suite · multi-database native storage · dynamic business baselines.

### Giữ làm infrastructure (không quảng bá thành sản phẩm)

Hotset storage · compaction · Resource Governor · Agent protocol · encryption · partitioning · metrics · error fingerprint.

---

## 58. Quy tắc quyết định tính năng

Mọi tính năng mới phải trả lời được **ít nhất một** câu:

```
1. Nó có ngăn công việc bị mất không?
2. Nó có ngăn retry hoặc effect nguy hiểm không?
3. Nó có phát hiện execution thành công nhưng business state sai không?
4. Nó có giúp phục hồi sai lệch an toàn không?
5. Nó có giữ performance, storage hoặc security trong ngân sách đã hứa không?
```

Không trả lời được câu nào → **tính năng đó không thuộc RhinoQ.**

---

## 59. Vấn đề mở

### 59.1 Ai viết verifier?

RhinoQ hứa xoá boilerplate, nhưng verifier là code người dùng phải viết. Ba hướng:

| Hướng                              | Ưu                     | Nhược                                      |
| ---------------------------------- | ---------------------- | ------------------------------------------ |
| User tự viết                       | linh hoạt              | boilerplate mới, nhiều người sẽ không viết |
| Adapter sẵn cho từng service       | zero-decision          | **maintenance vô hạn**                     |
| Không verify, chỉ `needs_decision` | an toàn, 0 maintenance | cần người can thiệp mỗi lần                |

**Quyết định:** hướng 3 ở v0.1 · primitive tổng quát (mục 11.7) ở v0.2 · adapter riêng **chỉ khi có contributor cho từng adapter**.

### 59.2 Hai đối tượng, một README

Effect/Outcome hấp dẫn team **đã** chạy production và **đã bị đau**. Zero-config hấp dẫn **app nhỏ chưa có queue**. Không thể nói với cả hai bằng một README.

**Đề xuất:** v0.1 nhắm nhóm thứ hai (dễ có user đầu tiên hơn) · v0.4 mở sang nhóm thứ nhất qua Adoption tools · landing page có hai đường dẫn riêng từ đầu.

---

## 60. Rủi ro

**Scope.** Tài liệu này mô tả bốn lớp và ~20 nhóm năng lực. Đây là **bản đồ**, không phải danh sách việc. v0.1 là 24 mục ở mục 55, và Effect chỉ có một quy tắc.

**Complexity làm mất người dùng.** Bốn lớp là khung mạnh nhưng dễ làm người mới bỏ chạy. Progressive disclosure (mục 17) là bắt buộc, không phải tuỳ chọn.

**Auto-tuning là rủi ro loại khác.** Không phải "chưa xong" mà là **có thể gây outage**. `mode: recommend` là mặc định bắt buộc.

**pg-boss cũng có transactional enqueue.** Khác biệt thật nằm ở VERIFY và RECOVER. Nếu bỏ hai lớp đó, RhinoQ chỉ là pg-boss có dashboard — cuộc chiến không thắng được.

**Động lực.** Câu phải tự trả lời thật: _bạn có thật sự đau vì cái này không?_ Với project open-source làm một mình, không có gì giữ bạn lại ngoài chính cái đau đó.

Cách kiểm tra rẻ nhất — hỏi 3 dev đang dùng BullMQ ở production:

1. Có bao giờ business record tạo rồi mà job không chạy?
2. Có bao giờ phải tra một job fail hôm qua mà không còn dữ liệu?
3. Có bao giờ lo worker chết giữa lúc gọi payment API?

Ba tin nhắn, một buổi tối. Nếu cả ba đều "chưa", đối tượng của bạn là nhóm khác.

---

## 61. Bước tiếp theo

1. **Kiểm tra tên** — `npm view rhinoq`, GitHub, `rhinoq.dev`
2. **Viết README trước khi viết code** — chỉ phần "5 phút đầu", **không nhắc Effect/Outcome ở trang đầu**. Nếu đọc lên mà chính bạn thấy _"cái này tôi muốn dùng"_, bạn có sản phẩm. Sửa README rẻ hơn sửa code rất nhiều
3. **Validate với 3 dev** (mục 60)
4. **Schema SQL** (mục 41) — chạy thật trên Postgres local, có partition ngay
5. **Batch claim + lease + reaper** (mục 42) — test bằng `kill -9` giữa lúc chạy
6. **Append-only attempts**
7. **Quy tắc effect duy nhất của v0.1** (mục 55, mục 12) — vài trăm dòng, giá trị lớn nhất
8. **Database role separation** (mục 33) — làm sớm, thêm sau rất khó
9. **Correlation + Business Explorer** — chưa cần đẹp, cần tra được `scanId`
10. **Publish v0.1 lên npm** dù còn thiếu
11. **Viết 2 bài blog** — _"Worker chết giữa lúc charge thẻ: vì sao mọi job queue đều retry mù"_ và _"Job completed không có nghĩa là xong"_. Đăng dev.to / r/node / Hacker News / Viblo
12. **Toàn bộ bằng tiếng Anh**

---

## 62. Phán quyết cuối

RhinoQ chỉ sạch và mạnh nếu giữ được chuỗi này:

```
Intent đã được ghi nhận.
Execution đã diễn ra.
Effect quan trọng đã được xác nhận.
Business invariant cần thiết đã đạt.
Nếu chưa đạt, có đường phục hồi an toàn.
```

RhinoQ **không cần nhiều tính năng hơn** BullMQ, Temporal hoặc các nền tảng khác. Nó cần làm **một việc sắc nét hơn**:

> **Biến khoảng cách giữa "job completed" và "business state chính xác" thành một phần có thể khai báo, quan sát và phục hồi ngay trong job queue.**

Performance, storage và security **không được dùng làm điểm quảng cáo chính**. Chúng là điều kiện nền để lời hứa trên tồn tại được trong production mà không làm hại ứng dụng của người dùng.

---

## Phụ lục — Hai mươi bốn nguyên tắc thiết kế

1. **Một job completed không đồng nghĩa công việc đã hoàn thành.** Câu này là toàn bộ sản phẩm.
2. **Bốn giai đoạn là cấu trúc public.** Tính năng nào không thuộc COMMIT/RUN/VERIFY/RECOVER thì là infrastructure hoặc không thuộc RhinoQ.
3. **Thà dừng và hỏi người, hơn là charge hai lần.** Mặc định của mọi tình huống không rõ là dừng.
4. **Phần lớn job ở Level 0.** Outcome là ngoại lệ cho workload quan trọng, không phải mặc định.
5. **Outcome kiểm invariant, không kiểm lại câu lệnh vừa chạy.** Constraint mạnh hơn Outcome cho việc đó.
6. **Chỉ Intent nằm trên request path.**
7. **Bán bằng bằng chứng, không bằng lời hứa.** `verify` chạy trên hạ tầng của họ; Observer chỉ ra lỗi của chính họ.
8. **Security là release gate, không phải mục tuỳ chọn.**
9. **Không bao giờ hy sinh dữ liệu nghiệp vụ để giữ log.**
10. **Không partition bảng đang được claim.** Chỉ partition dữ liệu lịch sử. Hot table giữ nhỏ bằng sweeper.
11. **Parity là điều kiện cần, không phải điểm cộng.** Queue cơ bản tệ hơn BullMQ thì không ai quan tâm Outcome.
12. **Không có precondition thì đừng làm Repair.** Plan phải có version, state hash và expiry.
13. **Phân biệt "sai" với "không biết".** `mismatch` và `unverifiable` là hai thứ khác nhau; gộp lại tạo false positive hàng loạt.
14. **Nói đúng về đối thủ.** Một câu sai về BullMQ làm mất niềm tin vào cả tài liệu.
15. **Fencing token ở mọi thao tác, không chỉ vài chỗ.** Bỏ sót một cái là mở lại đúng lỗ hổng.
16. **Không ghi tên thuật toán mà implementation chưa tương ứng.**
17. **Backpressure phải có ở cả hai đầu.** Chỉ chặn worker mà không chặn producer thì vẫn chết vì backlog.
18. **Database time là authority cho mọi thứ liên quan thời gian.** Worker clock chỉ dùng cho telemetry.
19. **Progressive disclosure phải thật, không chỉ nói.** Ví dụ đầu tiên trong docs không được có Effect hay Outcome.
20. **Một canonical API.** Nhiều cách khai báo job song song là nhiều cách để sai.
21. **CLI không tự sửa gì khi chưa được phép.** `init` tạo plan, `--apply` mới thực hiện.
22. **Mặc định phải là cách an toàn.** `effect.run()` là mặc định vì API thủ công dễ quên `confirm()`.
23. **Error phải dạy cách sửa.** Năm phần: what · why · what RhinoQ did · exact fix · verify command.
24. **Ship trước, hoàn thiện sau.** v0.1 đã publish tốt hơn v1 còn trên giấy.
