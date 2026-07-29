# RHINOQ — ĐỊNH HƯỚNG SẢN PHẨM VÀ KẾ HOẠCH TÁI CẤU TRÚC (v3)

> **Trạng thái:** tài liệu nghiên cứu và định hướng dài hạn. Nó không phải là
> danh sách capability đã có, cũng không thay thế product contract trong
> [`README.md`](./README.md),
> [`docs/product-positioning.md`](./docs/product-positioning.md),
> [`docs/task-platform.md`](./docs/task-platform.md) và
> [`.ai/PRODUCT_BASELINE.md`](./.ai/PRODUCT_BASELINE.md). Khi có mâu thuẫn,
> contract, test và implementation status thắng.

> **Định vị:** RhinoQ là lớp `Task` nằm giữa queue và giao diện người dùng. Nó quản lý toàn bộ vòng đời của tác vụ bất đồng bộ hướng tới người dùng — từ lúc backend tạo task, runtime thực thi, provider bên ngoài xử lý, frontend nhận tiến độ/kết quả, cho tới cancel, retry, history và xác minh kết quả — **mà không yêu cầu đổi queue hay viết lại worker**.
>
> **Thông điệp cốt lõi:**
> **Your queue stays. Your workers stay. Add the user-facing layer.**
>
> **Nguyên lý kỹ thuật nền tảng:**
> **Snapshot-first, transport-agnostic.** Frontend không subscribe vào một stream. Frontend subscribe vào một *entity có version*. SSE, WebSocket, long-poll, interval polling và sync engine chỉ là các transport cắm vào cùng một state model. Nguồn sự thật là row trong PostgreSQL, không phải chuỗi event bay qua mạng.

---

## 0. Trạng thái tài liệu

- Tài liệu này ghi lại hướng sản phẩm đề xuất sau khi không còn lấy `VERIFY`, reconciliation và PostgreSQL integrity làm cửa vào chính.
- Phiên bản ngắn và public-facing của định vị nằm ở
  [`docs/product-positioning.md`](./docs/product-positioning.md). Tài liệu này
  giữ lại analysis, alternatives và các proposal chưa được accept để người làm
  sau hiểu lý do, không được quảng bá chúng như code hiện có.
- Những phần cũ không bị xóa bỏ mặc định. Chúng được phân loại lại thành:
  - nền tảng runtime;
  - reliability primitives;
  - module nâng cao `Verified Tasks`;
  - công cụ vận hành.
- Định hướng mới ưu tiên giải quyết một vấn đề có tần suất sử dụng cao hơn: xây và vận hành các tính năng chạy lâu có giao diện cho người dùng.
- Tài liệu dựa trên:
  - cấu trúc repository RhinoQ hiện tại;
  - các năng lực runtime đã có;
  - toàn bộ chuỗi phân tích sản phẩm trong cuộc trao đổi;
  - khảo sát thị trường thực tế tháng 7/2026 với BullMQ, Trigger.dev, Inngest, Hatchet, Temporal/Restate/DBOS, và nhóm transport thuần (Ably, ElectricSQL, Centrifugo, Upstash Realtime, `resumable-stream`).

### 0.1. Thay đổi chính so với bản v1

| # | Nội dung | Lý do |
|---|---|---|
| 1 | Đổi định vị từ *"Stop rebuilding background task infrastructure"* sang *"Your queue stays"* | Câu cũ trùng thông điệp của Trigger.dev và Inngest suốt hai năm; đối đầu trực diện ở chỗ họ mature hơn là thua |
| 2 | Viết lại toàn bộ mục 5 (cạnh tranh) | Bản v1 đánh giá thấp đối thủ. Trigger.dev Realtime đã GA từ 2024; Inngest đưa realtime thành first-class trong SDK v4 (03/2026) |
| 3 | Nâng **Delivery** thành kiến trúc có transport pluggable (mục 8.10–8.16) | Bản v1 mô tả SSE + polling fallback như một hành vi cứng. Đó là một transport trong nhiều transport, và phải cấu hình được |
| 4 | Thêm **connection multiplexing** | Bản v1 ngầm định một SSE connection cho mỗi task. Giới hạn 6 connection/domain của HTTP/1.1 làm sập màn hình có nhiều task |
| 5 | Thêm **fan-out**, **coalescing**, **sharding** | Ba thứ quyết định hệ thống có scale nổi hay không. Bản v1 không có |
| 6 | Thêm **Stream channel** cho token/chunk (mục 9.6–9.8) và đưa vào MVP | Phần lớn nhu cầu long-running user-facing năm 2026 là AI generation. Bản v1 không có khái niệm stream |
| 7 | Thêm **Library mode** (mục 13.4) | Tệp người dùng mục tiêu là nhóm không muốn thêm service. Bản v1 chỉ có deployment dạng service riêng |
| 8 | Thêm **hợp đồng liveness cho external runtime** (mục 14.6) | Câu hỏi đầu tiên khi nghe "runtime-agnostic": worker BullMQ bị OOM kill thì RhinoQ biết bằng cách nào |
| 9 | Đưa **BullMQ adapter** từ Phase 5 lên Phase 2 | Đó là khác biệt cạnh tranh lớn nhất, không thể nằm ở giữa roadmap |
| 10 | Thêm mục 38 (license/business model) và mục 39 (câu hỏi mở) | Quyết định license ảnh hưởng tới kiến trúc, phải chốt trước khi code |

### 0.2. Thay đổi ở bản v2.1 — sau vòng phản biện kiến trúc

Năm điểm đầu là **lỗi correctness**, không phải bổ sung.

| # | Nội dung | Mục |
|---|---|---|
| 1 | **Sửa mô hình SSE multiplexing.** `EventSource` một chiều, không nhận được lệnh subscribe. Chuyển sang mô hình server-driven theo scope token | 8.11 |
| 2 | **Sửa lệch giữa snapshot và hot state.** Redis phát progress 60 nhưng Postgres mới có 55 → reload làm UI tụt. Snapshot API giờ là merge, version cấp ở một nơi duy nhất | 8.17 |
| 3 | **Tách state model thành bốn chiều.** `completed_with_warnings`, `needs_attention`, `result_expired` không cùng loại. Giờ là lifecycle · outcome · health · result, với `status` phẳng là projection chỉ đọc | 7.1 |
| 4 | **Chốt vị trí Native Runtime.** Nó là một execution backend, không phải bản sắc sản phẩm. Giải quyết mâu thuẫn giữa "không thay queue của bạn" và "Native có guarantee mạnh nhất" | 39.6 |
| 5 | **Chốt cardinality Provider Operations.** Thuộc Execution, không phải RuntimeType. Không có Provider Platform song song với Task Platform | 7.12, 11.0 |
| 6 | Thêm **TaskDefinition** — chống trôi thành `map[string]any`, và chặn lỗi retry task cũ chạy logic mới | 7.10 |
| 7 | Thêm **dispatch outbox + reconciler** — lấp lỗ hổng Postgres/Redis không cùng transaction trong adapter mode | 14.7 |
| 8 | Thêm **command semantics + bảng ưu tiên**, gồm policy cancel-gặp-complete | 8.18 |
| 9 | Thêm **RuntimeCapabilities contract** — bảng guarantee thành code, frontend ẩn nút không hoạt động | 14.6 |
| 10 | Thêm **hành vi khi chính RhinoQ down** — business worker không bao giờ phụ thuộc RhinoQ | 14.8 |
| 11 | Tách **bốn mặt phẳng xác thực**, và chặn lỗ hổng tin `ownerId` từ browser | 20.1–20.4 |
| 12 | Thêm **data governance** — redaction, encryption, delete cascade, audit raw access | 20.6 |
| 13 | Thêm **Result Contract** — checksum, availability, không lưu signed URL | 7.6 |
| 14 | Thêm **TaskError chuẩn hóa** — safeMessage vs internalMessage, retry theo category | 7.6b |
| 15 | Thêm **ba chế độ progress** cho task không biết trước total | 7.11 |
| 16 | Tách **ba giao diện** — Task Center, Operator Console, Developer Inspector | 19.6 |
| 17 | Thêm **protocol và compatibility versioning**, gồm quy tắc migration cho library mode | 40 |
| 18 | Chừa chỗ **parent/child task** mà không xây DAG engine | 7.13 |
| 19 | Thêm **ID xuyên suốt** và ba metric chứng minh lời hứa | 28.1 |
| 20 | Nâng cấp độ kiểm thử: model-based, conformance, chaos, version-skew; chín bất biến | 27.9 |

**Rút lại một khuyến nghị của bản v2.0:** ví dụ `ctx.stream("reasoning")` ở mục 9.6 không nên là chuẩn chung. Lý do và tên thay thế ở mục 20.6.

---

# 1. Tóm tắt điều hành

## 1.1. RhinoQ mới là gì?

RhinoQ mới không chỉ là queue, không chỉ là SSE wrapper và không chỉ là dashboard.

RhinoQ là **Async Task Infrastructure** gồm bốn lớp:

```text
1. Task Management
   Task lifecycle, ownership, attempts, steps, items, results

2. Execution
   RhinoQ Native Runtime hoặc adapter tới BullMQ/Celery/SQS/custom worker

3. External Provider Operations
   start, poll, webhook, retry, timeout, rate limit, fallback, normalize

4. Delivery
   snapshot API + transport layer (SSE / WebSocket / polling / sync engine)
   multiplexing, fan-out, coalescing, stream channel, history, frontend SDK
```

Trong bốn lớp trên:

- **Lớp 2 là khác biệt chiến lược.** Trigger.dev, Inngest và Hatchet đều yêu cầu task được viết theo SDK của họ và chạy trên runtime của họ. RhinoQ cho phép giữ nguyên runtime hiện có.
- **Lớp 3 là khác biệt kỹ thuật.** Chưa có sản phẩm nào đóng gói "gọi provider bất đồng bộ" thành một domain object có schema, polling policy, circuit breaker, fallback và cost idempotency.
- **Lớp 4 là chỗ dễ bị đánh giá sai.** Bản thân SSE mỏng, ai cũng viết được trong vài ngày. Giá trị nằm ở thứ transport không biết: ownership, attempt versioning, terminal convergence, multiplexing và coalescing.

Một câu mô tả dễ hiểu:

> **RhinoQ giúp đội phát triển thêm các tính năng chạy nền mà không phải tự xây lại toàn bộ hạ tầng từ backend, queue, provider, realtime đến frontend.**

## 1.2. Vì sao phải đổi hướng?

Định hướng cũ quanh integrity và reconciliation có giá trị kỹ thuật nhưng gặp vấn đề thị trường:

- sự cố business drift không xuất hiện hằng ngày ở phần lớn công ty;
- công ty nhỏ thường tự viết script;
- công ty vừa chỉ có nhu cầu cao trong một số ngành;
- công ty lớn khó tin một dự án mới can thiệp vào nghiệp vụ quan trọng;
- onboarding bằng Rule, Finding, SQL verification tương đối nặng;
- người dùng không cảm nhận giá trị ngay sau lần tích hợp đầu tiên.

Trong khi đó, vấn đề user-facing async task xuất hiện trong rất nhiều sản phẩm:

- import CSV/Excel;
- export báo cáo;
- scan/crawl/scrape;
- tải và xử lý video;
- OCR;
- AI generation;
- đồng bộ dữ liệu;
- bulk update;
- backup;
- chuyển đổi file;
- gửi chiến dịch;
- tạo báo cáo dài.

Nỗi đau này có tính lặp lại:

```text
POST tạo job
→ trả jobId
→ viết status endpoint
→ frontend polling
→ thêm SSE
→ xử lý reconnect
→ cancel
→ retry
→ result
→ history
→ ownership
```

RhinoQ cần biến toàn bộ phần đó thành hạ tầng dùng lại.

## 1.3. Quyết định chiến lược

### Kiến trúc

> **Native-first về guarantee, adapter-first về adoption, snapshot-first về delivery.**

- `RhinoQ Native Runtime` dùng PostgreSQL làm runtime bền vững và có guarantee mạnh nhất.
- Redis được hỗ trợ như hot layer cho realtime, buffer, cache và high-throughput execution.
- BullMQ là adapter hạng nhất để người dùng hiện có không phải migrate.
- Task Core không phụ thuộc BullMQ, NestJS, Redis hoặc một ngôn ngữ cụ thể.
- HTTP/JSON protocol là nền tảng đa ngôn ngữ.
- **Transport là interface, không phải quyết định kiến trúc.** SSE là mặc định, nhưng WebSocket, long-poll, interval polling và sync engine đều implement cùng một contract. Người dùng chọn được, và thêm transport mới không đụng vào core.
- **Hai chế độ triển khai ngang hàng:** service mode (container riêng) và library mode (nhúng vào app, dùng chính PostgreSQL của app). Library mode phục vụ nhóm A, service mode phục vụ nhóm B trở lên.

### Sản phẩm

Cửa vào sản phẩm là:

```text
Task lifecycle
+ reliable realtime
+ cancel/retry/history
+ result delivery
+ provider operation orchestration
```

Các tính năng cũ trở thành:

```text
Verified Tasks
Effect safety
Guarded replay
Findings
Workbench
```

### Tệp người dùng đầu tiên

Đội:

- Node.js/NestJS;
- đang dùng BullMQ hoặc có worker chạy nền;
- có từ 2–3 user-facing long-running operations trở lên;
- đang tự polling, SSE hoặc quản lý jobId;
- không muốn migrate toàn bộ workload sang Trigger.dev/Inngest.

---

# 2. Vấn đề người dùng cần giải quyết

## 2.1. Vấn đề không phải chỉ là queue

Queue chỉ trả lời:

```text
Job đang chờ, đang chạy, thành công hay thất bại?
```

Sản phẩm thực tế phải trả lời thêm:

```text
Người dùng đã yêu cầu việc gì?
Tác vụ đó thuộc người dùng/workspace nào?
Đang ở bước nào?
Đã xử lý được bao nhiêu item?
Có kết quả tạm thời nào dùng được chưa?
Có thể cancel không?
Có thể retry toàn bộ hay retry từng item?
Kết quả cuối nằm ở đâu?
Frontend mất kết nối thì trạng thái có hội tụ lại không?
```

## 2.2. Những việc backend thường phải tự viết

Với mỗi loại tác vụ chạy lâu, backend thường phải xây:

- task table;
- job-to-user mapping;
- task state machine;
- status endpoint;
- progress endpoint hoặc event publisher;
- SSE/WebSocket gateway;
- Redis Pub/Sub;
- cancel endpoint;
- retry endpoint;
- attempts;
- history;
- result endpoint;
- permission;
- retention;
- cleanup;
- provider polling;
- timeout;
- webhook;
- idempotency;
- fallback provider.

Khi sản phẩm có nhiều loại task, từng team dễ làm một kiểu:

```text
Export dùng polling
Scan dùng SSE
AI generation dùng WebSocket
Download không cancel được
Import không có history
```

RhinoQ phải chuẩn hóa tất cả thành một protocol và một bộ SDK.

## 2.3. Những việc frontend thường phải tự viết

Frontend thường phải tự:

- lưu `jobId`;
- polling theo interval;
- dừng polling ở terminal state;
- tăng/giảm polling khi lỗi;
- mở SSE;
- reconnect SSE;
- tránh SSE và polling ghi đè nhau;
- xử lý tab sleep;
- xử lý reload;
- map state queue sang UI;
- quản lý progress;
- gọi cancel/retry;
- load result;
- xử lý result hết hạn;
- cập nhật partial items;
- tránh render danh sách lớn gây lag.

RhinoQ phải làm frontend chỉ còn:

```tsx
const task = useRhinoTask(taskId);
const items = useRhinoTaskItems(taskId);
```

## 2.4. Những việc QA và support đang bị kéo vào

QA:

```text
POST tạo job
→ copy jobId
→ GET status trong Postman nhiều lần
→ tự đoán job có đứng hay không
```

Support:

```text
Nhờ backend kiểm tra Redis
→ tìm job
→ tìm log
→ hỏi kết quả ở database nào
```

RhinoQ cần cung cấp Task Inspector và Task Center để QA/support không phải chạm vào Redis hoặc biết queue internals.

---

# 3. Định vị sản phẩm

## 3.1. Định vị chính thức đề xuất

### Câu ngắn

> **Your queue stays. Your workers stay. Add the user-facing layer.**

### Câu đầy đủ

> **RhinoQ is the task layer between your queue and your UI. Keep BullMQ, Celery, SQS or your own workers — get task lifecycle, converging realtime progress, cancellation, retries, provider orchestration, partial results, streams and history.**

### Cho nhóm NestJS/BullMQ

> **Add production-ready task progress, cancellation, history and results to BullMQ without rebuilding the API and frontend plumbing.**

### Câu kỹ thuật (dùng cho HN / dev audience)

> **Snapshot-first task state. The transport is a detail.**
>
> Your frontend doesn't subscribe to a stream — it subscribes to a versioned entity. SSE when it works, polling when it doesn't, and a full page reload still lands on the correct state, because the source of truth is a Postgres row, not a sequence of events.

### Vì sao đổi câu ngắn

Câu cũ — *"User-facing async tasks for any background worker"* — mô tả đúng nhưng không nói được điều gì đối thủ không nói. Trigger.dev và Inngest đều bán "user-facing async tasks". Thứ họ **không** bán được là "giữ nguyên queue của bạn", vì mô hình kinh doanh của họ là sở hữu runtime. Câu ngắn phải chiếm đúng chỗ đó.

## 3.2. RhinoQ không phải gì?

RhinoQ không phải:

- BullMQ replacement thuần túy;
- Redis competitor;
- Kafka competitor;
- UI dashboard cho queue;
- chỉ là SSE wrapper;
- chỉ là React progress bar;
- workflow builder no-code;
- BPMN engine;
- AI agent platform;
- database chứa toàn bộ business entities;
- provider marketplace khổng lồ ngay từ đầu.

## 3.3. Lời hứa giá trị

Khi thêm một task mới, developer chỉ cần viết:

```ts
// API
const task = await rhinoq.tasks.enqueue("scan-channel", {
  ownerId: user.id,
  input: { channelUrl },
});

// Worker
await ctx.progress({ step: "scanning", current: 20, total: 100 });
await ctx.complete({ resultRef });

// Frontend
const task = useRhinoTask(taskId);
```

Và không cần tự tạo:

```text
task table
status controller
SSE gateway
polling fallback
reconnect
version reducer
cancel API
retry API
history
result API
authorization
```

---

# 4. Mô hình người dùng và mức ưu tiên

## 4.1. Nhóm A — Solo developer và team nhỏ

### Nhu cầu cao khi

- có nhiều hơn một task chạy lâu;
- đang dùng BullMQ/NestJS;
- có frontend customer-facing;
- đang polling;
- phải hiển thị tiến độ;
- cần cancel/retry;
- không muốn cài một workflow platform lớn.

### Nhu cầu thấp khi

- chỉ có một cron nội bộ;
- chỉ có một export đơn giản;
- job chạy vài giây;
- không cần user theo dõi;
- polling đơn giản là đủ.

### Điều kiện adoption

- một Docker Compose;
- không bắt buộc Redis nếu chưa cần;
- tích hợp đầu tiên dưới một buổi;
- task thứ hai thêm trong vài phút;
- zero-progress mode vẫn dùng được.

## 4.2. Nhóm B — Startup và công ty vừa

Đây là nhóm khách hàng tốt nhất.

Họ có:

- nhiều loại async operations;
- nhiều team;
- nhiều màn hình;
- task implementation không thống nhất;
- nhu cầu multi-tenant;
- QA/support cần xem trạng thái;
- queue hiện tại không muốn thay.

Giá trị lớn nhất:

```text
Chuẩn hóa toàn công ty
+ giảm code lặp
+ giảm bug frontend
+ có một Task Center
```

## 4.3. Nhóm C — Enterprise

Không phải nhóm đầu tiên.

Họ cần:

- self-hosting;
- audit;
- RBAC;
- HA;
- SSO;
- retention;
- regional deployment;
- adapter nhiều runtime;
- compatibility guarantees.

RhinoQ cần có case study trước khi nhắm enterprise.

## 4.4. Nhóm D — Đội chưa có queue/runtime

Họ có thể ưu tiên Trigger.dev, Inngest hoặc nền tảng managed vì được cấp cả runtime và realtime.

RhinoQ vẫn có thể phục vụ bằng Native Runtime, nhưng không nên cạnh tranh trực diện ở giai đoạn đầu.

---

# 5. Phân tích cạnh tranh và khoảng trống

## 5.1. BullMQ

BullMQ đã làm tốt:

- enqueue;
- Redis-backed queue;
- retries;
- delay;
- progress primitive;
- events;
- cancellation primitive;
- result value;
- worker lifecycle.

BullMQ chưa cung cấp trọn bộ user-facing layer:

- scoped user token;
- task ownership;
- SSE/polling gateway;
- React task hook;
- task history theo user;
- multi-execution task;
- provider operation;
- result delivery;
- partial item model;
- verified completion.

RhinoQ không cạnh tranh với BullMQ về raw queue throughput. RhinoQ biến primitive của BullMQ thành product task lifecycle.

## 5.2. Trigger.dev, Inngest, Hatchet — đánh giá lại (07/2026)

> Bản v1 viết "các nền tảng này làm tốt: realtime, hooks". Đó là đánh giá thấp. Cả ba đã GA, có docs đầy đủ, self-host được, và đang ở vòng lặp thứ ba tới thứ tư của API. Phải nhìn đúng để không định vị vào chỗ đã bị chiếm.

### Trigger.dev

Realtime ra beta từ 10/2024 và GA cuối 2024. Hiện có:

- `auth.createPublicToken()` với scope theo từng run/tag/batch và `expirationTime`;
- `useRealtimeRun`, `useRealtimeRunsWithTag`, `useRealtimeRunWithStreams`, `useRealtimeTaskTrigger`;
- `baseURL` để hook trỏ về instance self-host;
- run metadata cho custom realtime update ngoài status/output.

Về mặt kỹ thuật, Realtime của họ chạy trên **ElectricSQL** — bài toán convergence được giải bằng sync engine trên Postgres logical replication, không phải reducer tự viết. Đây là lựa chọn kiến trúc RhinoQ phải trả lời được (xem mục 39.1).

**Kết luận: `useRealtimeRun` gần như trùng với `useRhinoTask` trong mục 3.3 của bản v1.** Không thể coi hook + scoped token là differentiator.

### Inngest

- Realtime ra developer preview 05/2025, GA sau đó;
- 03/2026: realtime thành first-class trong SDK v4, hook `useRealtime` từ `inngest/react`, package `@inngest/realtime` cũ bị deprecate;
- hook tự quản WebSocket, reconnect, buffering, token refresh và typed access theo topic;
- phân biệt rõ `step.realtime.publish()` cho state transition quan trọng (replay được khi retry) và `inngest.realtime.publish()` cho progress tick tần suất cao.

**Điểm cần chú ý:** sự phân biệt publish thứ hai chính là vấn đề attempt/version mà mục 6.3 của RhinoQ đang giải. Họ đã có một câu trả lời cho nó, dù không mạnh bằng snapshot-first.

### Hatchet

- 100% MIT, Postgres-native, không bắt buộc RabbitMQ dưới ~100 req/s;
- Hatchet Lite là một docker image duy nhất;
- SDK Python, TypeScript, Go, Ruby;
- argument "task ack + task result + higher-order model trong cùng một Postgres transaction" — họ dùng từ 2024.

**Kết luận: góc "Postgres-native, self-host nhẹ" đã bị chiếm.** RhinoQ không thắng được bằng argument này. Muốn nhẹ hơn Hatchet thì phải là library mode (mục 13.4), không phải "cũng một docker compose".

### Khoảng trống thật sự còn lại

| Khoảng trống | Vì sao chưa ai lấp |
|---|---|
| **Task layer độc lập runtime** | Cả ba đều sở hữu runtime. Mô hình kinh doanh của họ không cho phép hỗ trợ worker chạy ngoài |
| **Provider Operations như first-class entity** | Ai cũng viết logic poll/webhook/fallback bên trong step function. Không ai đóng gói thành object có schema và policy |
| **Task Item lifecycle với per-item retry** | Batch thì Trigger có. Item-level state + projection API + cursor pagination phục vụ UI thì không |
| **Verified completion** | Không nền tảng nào chặn `completed` cho tới khi output được xác minh tồn tại |

## 5.3. Nhóm transport thuần

Đây là nhóm bản v1 hoàn toàn bỏ sót, và là nhóm dễ khiến "reliable realtime" mất giá trị nhất.

- **Ably, Pusher, Centrifugo, Upstash Realtime** — offset-based replay, fan-out đa thiết bị, catch-up sau reconnect, durable session. Giải bài toán transport rất tốt.
- **ElectricSQL, Zero (Rocicorp)** — sync engine, đồng bộ subset của Postgres xuống client với convergence tự động. Trigger.dev đã dùng Electric.

**Nhưng cả nhóm này chỉ biết `channel` và `message`.** Chúng không biết task là gì, không biết ai sở hữu nó, không biết attempt nào đang chạy, không có cancel/retry/history. Người dùng vẫn phải tự map queue state sang channel, tự viết reducer, tự viết authorization.

## 5.4. Nhóm bundled trong AI chat

- `resumable-stream` của Vercel buffer token vào Redis server-side; client reload thì replay từ chỗ dừng, generation vẫn chạy tiếp trên server.
- Giới hạn: chỉ xử lý tốt trường hợp reload trang, single-device, gắn chặt Next.js, và bắt người dùng tự vận hành Redis.
- Hệ quả: đã sinh ra một loạt biến thể — `zirkelc/ai-resumable-stream`, Upstash Realtime, Ably AI Transport, durablr.

**Đây là bằng chứng thị trường quan trọng nhất trong toàn bộ khảo sát:** mọi team đều đang tự build lại cùng một workaround Redis, và chưa ai đóng gói được nó ở tầng *task* thay vì tầng *chat*.

Đồng thời nó là cảnh báo: **RhinoQ bắt buộc phải có stream channel** (mục 9.6–9.8). Nếu task của người dùng là AI generation, họ cần cả hai — snapshot cho state, stream cho token — và hiện chỉ Trigger.dev đưa được cả hai qua một hook.

## 5.5. Bản đồ định vị

```text
                          Có task semantics?
                     không                    có
                ┌─────────────────────┬─────────────────────┐
  Runtime của   │                     │  Trigger.dev        │
  nhà cung cấp  │         —           │  Inngest            │
                │                     │  Hatchet            │
                ├─────────────────────┼─────────────────────┤
  Runtime của   │  Ably               │                     │
  người dùng    │  ElectricSQL        │      RHINOQ         │
                │  Centrifugo         │      (ô trống)      │
                │  resumable-stream   │                     │
                └─────────────────────┴─────────────────────┘
```

RhinoQ chiếm ô dưới bên phải. Đó là ô duy nhất chưa có sản phẩm.

## 5.6. Tự code

Đối thủ lớn nhất vẫn là "tự viết nhanh".

Một endpoint polling đơn giản viết trong nửa ngày. Một SSE gateway cơ bản viết trong hai ba ngày. **Nếu RhinoQ bán "hạ tầng SSE và polling" thì đang bán đúng phần dễ nhất và sẽ thua "tự code".**

RhinoQ chỉ có giá trị khi giải quyết những thứ mà transport không biết và người ta hay làm sai:

- attempt versioning — event của attempt cũ không được ghi đè attempt mới;
- terminal convergence — state cuối không bị state cũ đè, kể cả khi event tới lệch thứ tự;
- authorization scoped theo user, không phải server token chung;
- multiplexing — nhiều task chung một connection;
- coalescing — 10.000 progress event xuống còn vài chục;
- missed event recovery không phụ thuộc buffer còn hạn;
- ownership + history sống lâu hơn queue retention;
- partial item lifecycle;
- provider orchestration.

## 5.7. Khác biệt cần giữ

```text
1. Existing queue friendly          ← khác biệt chiến lược số một
2. Snapshot-first convergence       ← khác biệt kỹ thuật số một
3. Transport-agnostic delivery
4. Provider operation orchestration
5. Partial result and item lifecycle
6. Stream channel bên cạnh snapshot channel
7. Payload safety and result references
8. Optional verified completion
9. Native PostgreSQL runtime plus Redis hot path
10. Library mode bên cạnh service mode
```

Ba dòng đầu là thứ phải xuất hiện trong hero của README. Bảy dòng còn lại là chiều sâu, không phải cửa vào.

---

# 6. Nguyên tắc thiết kế sản phẩm

## 6.1. Task là thực thể độc lập với Job

Sai:

```text
taskId = BullMQ jobId
```

Đúng:

```text
Task
├── Execution 1: RhinoQ Native
├── Execution 2: BullMQ job
├── Execution 3: external provider operation
└── Result references
```

Lợi ích:

- retry không thay đổi Task ID;
- frontend không phụ thuộc queue;
- một task có nhiều execution;
- đổi runtime không đổi UI;
- task history sống lâu hơn queue retention.

## 6.2. Snapshot là nguồn đọc hiện tại

Frontend luôn lấy snapshot trước:

```http
GET /v1/tasks/{taskId}
```

SSE chỉ bổ sung thay đổi mới.

## 6.3. Event không phải source duy nhất

Không giả định client luôn online.

Mỗi event có:

- sequence/version;
- task attempt;
- item version;
- occurredAt.

Client reconnect có thể:

- replay event thiếu;
- hoặc lấy snapshot mới.

## 6.4. Dữ liệu lớn không truyền qua realtime channel

SSE chỉ truyền:

- status;
- progress;
- summary nhỏ;
- reference;
- invalidation signal.

Raw result lớn nằm ở object storage.

## 6.5. Người dùng không phải bắt buộc khai báo progress

Ba mức tích hợp:

### Level 0 — lifecycle tự động

```ts
rhinoq.attachWorker(worker);
```

Có:

```text
queued → running → completed/failed
```

### Level 1 — progress

```ts
ctx.progress(50);
```

### Level 2 — steps/items/results/provider

```ts
ctx.step(...)
ctx.items.upsert(...)
ctx.provider.run(...)
ctx.complete(...)
```

## 6.6. PostgreSQL là durable truth, Redis là hot path

Không cực đoan chọn một.

## 6.7. Transport là plugin, không phải quyết định kiến trúc

Nguyên tắc: **client không được biết mình đang chạy trên transport nào.**

```ts
interface TaskTransport {
  subscribe(
    taskIds: string[],
    onSnapshot: (snapshot: TaskSnapshot) => void,
    onError: (error: TransportError) => void,
  ): Unsubscribe;
  close(): void;
}
```

SSE, WebSocket, long-poll, interval polling, và sau này sync engine (Electric/Zero) đều implement cùng interface. Reducer và hook không biết gì về transport.

Hệ quả:

- người dùng chọn được transport, không bị ép;
- thêm transport mới không đụng vào core;
- không bị khóa vào SSE nếu hai năm nữa có thứ tốt hơn;
- test được reducer mà không cần dựng network.

**Fallback không phải là đổi công cụ.** SSE và polling đọc cùng một nguồn — một snapshot có version. Không có hai state machine, không có chuyện SSE nói xong mà polling nói đang chạy. Đây là điểm khác biệt so với mô hình buffer-and-replay, nơi hai đường dữ liệu có thể phân kỳ.

## 6.8. Auto là mặc định, không phải luật

```ts
useRhinoTask(taskId, { transport: "sse" })     // chỉ SSE; đứt thì trả error
useRhinoTask(taskId, { transport: "ws" })      // chỉ WebSocket
useRhinoTask(taskId, { transport: "poll" })    // chỉ polling
useRhinoTask(taskId, { transport: "auto" })    // mặc định: SSE, degrade khi cần
useRhinoTask(taskId, { transport: myTransport }) // tự cắm
```

Người muốn SSE thuần thì đặt `transport: "sse"`, kết nối đứt là `connection.state === "error"`, tự xử lý. Không có hành vi ngầm.

Nhưng `auto` là mặc định vì các lý do có thật, không phải vì thận trọng thừa:

| Tình huống | Hệ quả với SSE thuần |
|---|---|
| HTTP/1.1 giới hạn 6 connection/domain | Mở tab hoặc task thứ 7 là treo vô hạn. HTTP/2 multiplex thì hết, nhưng proxy nội bộ của khách hàng chưa chắc bật |
| Proxy doanh nghiệp cắt kết nối dài | SSE bị terminate trước khi response về tới |
| iOS Safari giết connection khi tab vào background | Người dùng chuyển app 30 giây rồi quay lại, SSE đã chết mà không phát `error` |
| Load balancer idle timeout (ALB mặc định 60s) | Task chạy 20 phút không có progress là bị cắt |
| Serverless / edge | SSE có trần thời gian cứng |

## 6.9. Hai loại kênh có yêu cầu ngược nhau

Đây là phân biệt then chốt, bản v1 không có:

| | Snapshot channel | Stream channel |
|---|---|---|
| Nội dung | state của task/item | token, chunk, log line |
| Ngữ nghĩa | latest-wins | append-only |
| Bỏ bớt được không? | **có** — chỉ giá trị mới nhất quan trọng | **không** — mất chunk là hỏng output |
| Cơ chế phục hồi | đọc lại snapshot | replay từ offset |
| Lưu trữ | PostgreSQL row | ring buffer (Redis) + optional archive |
| Coalescing | bắt buộc | cấm |

Gộp hai loại này vào một kênh là sai. Task chạy 10.000 item báo progress 10.000 lần thì client chỉ cần thấy vài chục lần — bỏ bớt thoải mái. Nhưng token của LLM thì mất một cái là output sai.

## 6.10. Không tự viết lại thứ đã có nếu không thắng được

Trước khi tự implement một cơ chế, phải trả lời: cơ chế đã có ngoài kia thua ở điểm nào?

- SSE gateway thuần → thua ở chỗ không biết task, không biết ownership. **Đáng viết.**
- Buffer-and-replay cho stream → `resumable-stream` đã tốt. **Cân nhắc dùng lại thay vì viết.**
- Sync engine cho convergence → Electric đã tốt và Trigger.dev đã dùng. **Phải trả lời rõ ở mục 39.1 trước khi tự viết reducer.**

---

# 7. Mô hình domain mới

## 7.1. Task và mô hình trạng thái bốn chiều

> **Sửa lớn so với bản v2.0.** Danh sách status phẳng cũ trộn bốn chiều khác nhau vào một enum. `completed_with_warnings` là *outcome*, `needs_attention` là *health*, `result_expired` là *trạng thái của result*, còn `running` mới là *lifecycle*. Trộn chung khiến retry logic, filter UI, reducer và analytics đều phải viết điều kiện chồng chéo.

### Bốn chiều độc lập

```go
type Task struct {
    ID         TaskID
    Definition TaskDefinitionRef   // name + version, xem 7.10
    OwnerID    string
    TenantID   string

    // Chiều 1 — Lifecycle: task đang ở đâu trong vòng đời
    Lifecycle  Lifecycle           // queued | running | terminal

    // Chiều 2 — Outcome: chỉ có nghĩa khi Lifecycle == terminal
    Outcome    *Outcome            // succeeded | partial | failed | cancelled

    // Chiều 3 — Health: tình trạng vận hành, độc lập lifecycle
    Health     Health              // healthy | stalled | needs_attention
    HealthReason *HealthReason

    // Chiều 4 — Result: trạng thái của dữ liệu kết quả
    Result     ResultState         // none | available | expired | deleted | missing

    Attempt    int
    Version    int64
    Progress   Progress            // xem 7.11
    Summary    map[string]any
    CompletionPolicy CompletionPolicy
    ParentTaskID *TaskID           // xem 7.13
    RootTaskID   TaskID
    CreatedAt  time.Time
    UpdatedAt  time.Time
    EndedAt    *time.Time
}
```

```text
Lifecycle:  queued · running · terminal
Outcome:    succeeded · partial · failed · cancelled
Health:     healthy · stalled · needs_attention
Result:     none · available · expired · deleted · missing
```

### HealthReason

`needs_attention` không có ý nghĩa nếu không nói rõ vì sao:

```text
worker_stalled
execution_orphaned
dispatch_failed
result_missing
checksum_mismatch
verification_failed
runtime_state_unknown
provider_exhausted
```

### Trạng thái trung gian của lifecycle

```text
queued
  ├── pending_dispatch     (xem 14.7 — task đã tạo, chưa bind được execution)
  └── queued
running
  ├── running
  ├── retrying
  └── cancellation_requested
terminal
```

### Status phẳng vẫn tồn tại, nhưng là derived

Frontend và filter không nên phải tự tổ hợp bốn chiều. RhinoQ tính sẵn một `status` phẳng:

```ts
function deriveStatus(t: Task): string {
  if (t.health === "needs_attention") return "needs_attention";
  if (t.lifecycle !== "terminal") {
    if (t.health === "stalled") return "stalled";
    return t.lifecycle;              // queued | running
  }
  if (t.outcome === "succeeded" && t.result === "expired") return "result_expired";
  return t.outcome!;                 // succeeded | partial | failed | cancelled
}
```

**Quy tắc quan trọng:** `status` là **projection chỉ đọc**, không bao giờ là nguồn để ghi. Mọi command và reducer thao tác trên bốn chiều gốc. Nếu để code ghi thẳng vào `status`, mô hình sẽ trôi ngược về enum phẳng trong vòng vài tháng.

### Vì sao tách ra lại sạch hơn

| Trường hợp | Enum phẳng | Bốn chiều |
|---|---|---|
| Task xong nhưng result hết hạn | thêm state `result_expired`, mất thông tin đã succeeded | `terminal + succeeded + expired` |
| Task đang chạy nhưng worker treo | không biểu diễn được, phải bịa state | `running + stalled` |
| Task cancelled nhưng vẫn có partial result | không biểu diễn được | `terminal + cancelled + available` |
| Retry được không? | phải kiểm tra 5 giá trị | `lifecycle == terminal && outcome != succeeded` |
| Filter "task cần xử lý" | liệt kê state | `health != healthy` |

## 7.2. Execution

Một lần thực thi kỹ thuật.

```go
type Execution struct {
    ID          ExecutionID
    TaskID      TaskID
    Runtime     RuntimeType
    ExternalRef *ExecutionRef
    Attempt     int
    Status      ExecutionStatus
    LeaseOwner  *string
    LeaseEpoch  int64
    StartedAt   *time.Time
    FinishedAt  *time.Time
}
```

Runtime có thể là:

```text
native-postgres
bullmq
celery
sqs
rabbitmq
custom-http
provider-operation
```

## 7.3. Task Attempt

Mỗi retry toàn task tạo attempt mới.

```text
Task attempt 1
→ failed at 80%

Task attempt 2
→ running at 10%
```

Event của attempt cũ không được ghi đè attempt mới.

## 7.4. Step

Các giai đoạn có ý nghĩa với người dùng.

```text
validate
scan
download
upload
finalize
```

```go
type TaskStep struct {
    TaskID      TaskID
    StepID      string
    Status      StepStatus
    Weight      float64
    Current     *int64
    Total       *int64
    Progress    *float64
    Version     int64
}
```

## 7.5. Task Item

Từng kết quả con của batch operation.

Ví dụ:

```text
Task: Download 10 videos
├── Item video_1
├── Item video_2
└── Item video_10
```

```go
type TaskItem struct {
    TaskID       TaskID
    Key          string
    Status       ItemStatus
    Attempt      int
    Version      int64
    Progress     ProgressSnapshot
    Summary      map[string]any
    ResultRef    *ResultRef
    RawResultRef *ResultRef
    Error        *TaskError
}
```

### Item status

```text
discovered
queued
running
retrying
completed
failed
cancelled
skipped
```

## 7.6. ResultRef và Result Contract

Không nhét payload lớn vào task. Nhưng chỉ mô tả vị trí là chưa đủ cho production — kết quả cần bất biến và xác minh được.

```go
type ResultRef struct {
    Provider        string      // app-db | s3 | gcs | inline | ...
    Key             string
    Version         string      // định danh phiên bản của chính result
    Checksum        *string     // sha256, khuyến nghị bắt buộc với object storage
    ContentType     string
    ContentEncoding string
    SizeBytes       *int64
    Availability    ResultState // available | expired | deleted | missing
    Immutable       bool
    CreatedAt       time.Time
    ExpiresAt       *time.Time
}
```

### Không lưu signed URL

Signed URL hết hạn. Lưu nó vào Task nghĩa là history sẽ đầy link chết sau vài giờ.

```ts
// SAI
resultRef: { url: "https://s3...?X-Amz-Expires=3600" }

// ĐÚNG
resultRef: { provider: "s3", key: "tasks/123/report.xlsx" }

// Cấp URL tại thời điểm đọc
const url = await resultResolver.resolve(resultRef, {
  user,
  expiresIn: "5m",
});
```

`ResultResolver` là một port, người dùng cắm implementation của mình. RhinoQ không cần biết cách ký URL của từng provider.

### Các câu hỏi phải chốt

| Câu hỏi | Quyết định |
|---|---|
| Retry có ghi đè result cũ không? | **Không.** Mỗi attempt có result riêng; Task trỏ tới `latestResultRef` |
| Task có giữ result của attempt cũ không? | Có, trong `rhinoq_task_attempts`, phục vụ history và so sánh |
| Partial result có thành final result không? | Có, nếu `completionPolicy` cho phép; đánh dấu `outcome = partial` |
| Task succeeded nhưng result expired thì còn succeeded không? | **Còn.** `outcome` không đổi, `result` chuyển `expired` (đây là lý do tách bốn chiều ở 7.1) |
| Checksum mismatch thì sao? | `health = needs_attention`, `healthReason = checksum_mismatch`. Không tự đổi outcome |
| Result bị xóa ngoài ý muốn? | `result = missing` + `needs_attention` |

### Kiểm tra định kỳ

Reconciler quét result gần hết hạn hoặc đã quá hạn, cập nhật `Availability`. Không đợi tới lúc người dùng bấm mở mới phát hiện link chết.

## 7.6b. TaskError — mô hình lỗi chuẩn hóa

Không để worker gửi chuỗi lỗi tự do. Chuỗi tự do dẫn tới ba hậu quả: frontend hiển thị stack trace cho người dùng cuối, retry không tự động được, và analytics không phân biệt được bug hệ thống với lỗi nhập liệu.

```go
type TaskError struct {
    Code            string        // "provider.timeout", "input.invalid_url"
    Category        ErrorCategory
    Retryable       bool
    SafeMessage     string        // hiển thị cho người dùng cuối
    InternalMessage *string       // chỉ operator/developer đọc được
    DetailsRef      *ResultRef    // stack trace, response body đầy đủ
    OccurredAt      time.Time
}
```

```text
ErrorCategory:
  validation      lỗi input, không retry
  provider        lỗi bên thứ ba
  timeout
  rate_limit
  worker_crash
  cancelled
  internal        bug của chính hệ thống
```

Quy tắc:

- `SafeMessage` **không bao giờ** chứa stack trace, credential, URL nội bộ, tên bảng, hay raw response của provider.
- `InternalMessage` và `DetailsRef` chỉ trả về cho caller có permission `task:raw:read`.
- Retry tự động quyết định theo `Category` + `Retryable`, không theo chuỗi message.
- SDK cung cấp helper để wrap lỗi, mặc định `category: "internal"`, `retryable: false` — an toàn hơn là đoán.

## 7.7. ProviderOperation

Đại diện cho một request tới external provider.

```go
type ProviderOperation struct {
    ID                OperationID
    TaskID            TaskID
    Provider          string
    OperationType     string
    ExternalRequestID string
    Status            ProviderStatus
    Attempt           int
    PollCount         int
    NextPollAt        *time.Time
    Cost              *decimal.Decimal
    RawResultRef      *ResultRef
}
```

## 7.8. MappingDefinition

Định nghĩa cách lấy dữ liệu provider.

```ts
type MappingDefinition = {
  version: number;
  inputSchema?: Schema;
  itemPath?: string;
  fields: Record<string, FieldMapping>;
  outputSchema: Schema;
};
```

## 7.9. Verified Task

Module nâng cao:

```text
Execution completed
→ result verification
→ Task terminal
```

Nếu output không tồn tại:

```text
health = needs_attention
healthReason = result_missing
```

## 7.10. TaskDefinition

> Bổ sung quan trọng. Không có nó, RhinoQ trôi dần thành một tập `map[string]any` với convention không kiểm soát được.

Task hiện tại quá động: `type` là chuỗi tự do, `input` và `result` là JSON bất kỳ, không ai biết task nào hỗ trợ cancel hay stream.

```ts
type TaskDefinition = {
  name: "scan-channel";
  version: 3;

  inputSchema?: Schema;      // tùy chọn — xem ghi chú bên dưới
  resultSchema?: Schema;
  summarySchema?: Schema;

  execution: {
    runtime: "bullmq";
    queue: "scan";
  };

  capabilities: {
    cancellable: true;
    retryable: true;
    streaming: false;
    itemized: true;
  };

  progress: {
    mode: "count";           // xem 7.11
    monotonic: true;
  };

  retention: {
    taskDays: 90;
    eventDays: 14;
    resultDays: 30;
  };

  dataPolicy: DataPolicy;    // xem 20.6
};
```

Giải quyết được:

- validate input/output tại biên, không để lỗi lọt xuống worker;
- sinh type cho frontend từ definition;
- Task Inspector biết cách hiển thị mà không cần hardcode;
- task cũ vẫn dùng definition version cũ khi đọc history;
- **retry task cũ không vô tình chạy logic mới** — đây là lỗi âm thầm và khó phát hiện nhất trong danh sách;
- xác định task nào có cancel/retry/item/stream, để UI không hiện nút không hoạt động.

### Schema là tùy chọn, definition là bắt buộc

Bắt buộc khai schema ngay từ task đầu tiên làm tăng ma sát adoption — đi ngược mục tiêu "tích hợp dưới một buổi". Nên:

- **Bắt buộc:** đăng ký definition với `name`, `version`, `capabilities`.
- **Tùy chọn:** schema. Không khai thì RhinoQ không validate, và cảnh báo một lần khi khởi động.
- **Khuyến khích:** khai schema khi lên production, có công cụ sinh schema từ sample input.

### Versioning

```text
Task lưu: definitionName + definitionVersion
Retry:    dùng đúng version đã lưu, không dùng version mới nhất
Đọc history: hiển thị theo definition tại thời điểm tạo
Definition bị xóa: task cũ vẫn đọc được, không retry được
```

Đổi `capabilities` hoặc `execution` là **breaking**, phải tăng version. Đổi `retention` hoặc thêm field optional vào schema là **additive**, giữ nguyên version.

## 7.11. Progress — ba chế độ

Không phải task nào cũng biết trước tổng số. "Đã tìm thấy 50 video" không có nghĩa là 50%.

```ts
type Progress =
  | { mode: "indeterminate"; message?: string }
  | { mode: "count"; current: number; total?: number; message?: string }
  | { mode: "percentage"; value: number; confidence: "exact" | "estimated" };
```

`count` với `total` chưa xác định là trường hợp phổ biến nhất khi scan/crawl: biết đã xử lý bao nhiêu, chưa biết còn bao nhiêu.

### Các quy tắc phải chốt

| Câu hỏi | Quyết định |
|---|---|
| `total` tăng lên thì phần trăm có giảm không? | **Có**, nếu `monotonic: false`. Nếu `monotonic: true` thì phần trăm giữ nguyên và chỉ `current`/`total` thay đổi |
| Progress có bắt buộc monotonic không? | Không bắt buộc, khai trong TaskDefinition |
| Retry một item có làm task progress lùi không? | **Không.** Progress của task tính theo `completed items`, retry item chỉ chuyển item đó khỏi `completed` nếu nó từng completed — trường hợp hiếm, xử lý bằng `monotonic` |
| `estimated` hiển thị khác `exact` thế nào? | SDK component render `estimated` với dấu `~` và không hiện ETA |
| Weighted step thì progress tổng tính sao? | `sum(step.weight × step.progress) / sum(step.weight)`, step chưa bắt đầu tính 0 |

Nếu không chốt, mỗi adapter và mỗi task type sẽ tính progress một kiểu — đúng cái vấn đề mục 2.2 nói RhinoQ tồn tại để chấm dứt.

## 7.12. ProviderOperation thuộc về Execution

> Sửa mâu thuẫn trong bản v2.0: `provider-operation` vừa xuất hiện như một `RuntimeType` ở 7.2, vừa là entity riêng ở 7.7. Hai vai trò này xung đột.

Chốt cardinality:

```text
Task
└── Attempt
    └── Execution                     (runtime: native | bullmq | http | ...)
        └── 0..N ProviderOperation
```

`provider-operation` **bị loại khỏi danh sách RuntimeType.** Provider operation không phải một runtime — nó là công việc mà một execution thực hiện.

Hệ quả:

- một execution có thể gọi nhiều provider (primary + fallback) mà không cần tạo execution mới;
- cancel execution thì cancel toàn bộ provider operation con của nó;
- retry task tạo attempt mới → execution mới → provider operation mới, không kế thừa;
- Provider Ops không bao giờ tồn tại độc lập ngoài một Task.

Điều này giữ RhinoQ là **một** platform, không tách thành Task Platform + Provider Platform.

## 7.13. Parent/Child — chừa chỗ, không xây DAG engine

Nhiều task thực tế sinh task con:

```text
Import CSV
├── Validate file
├── Process batch 1
├── Process batch 2
└── Generate report
```

RhinoQ **không** làm workflow DAG engine (mục 3.2 giữ nguyên). Nhưng domain phải chừa chỗ, vì thêm quan hệ cha–con sau khi đã có Task Items và Provider Operations sẽ khiến ba khái niệm chồng vai trò.

```go
ParentTaskID *TaskID
RootTaskID   TaskID          // luôn có, bằng ID nếu là root
Relationship *Relationship   // child | continuation | compensation
```

V1 chỉ làm:

- lưu quan hệ;
- `GET /v1/tasks/{id}/children`;
- không tự động tổng hợp progress của cha;
- không tự động cancel cascade;
- không có completion policy ở cấp cha.

V2 mới cân nhắc tổng hợp (`3/4 children completed`) và cascade. Đến lúc đó dữ liệu đã có sẵn, không phải migration đau.

### Phân biệt với Task Item

| | Task Item | Child Task |
|---|---|---|
| Có lifecycle riêng? | có, nhưng đơn giản | có, đầy đủ |
| Có execution riêng? | không | có |
| Có TaskDefinition riêng? | không | có |
| Dùng khi | batch đồng nhất, hàng nghìn phần tử | các bước khác loại nhau |

Nếu một task sinh 10.000 phần tử giống nhau → Items. Nếu sinh 4 bước khác loại → Child Tasks.

---

# 8. Cơ chế end-to-end và tầng Delivery

## 8.1. Tạo task

```http
POST /v1/tasks
```

```json
{
  "type": "scan-tiktok-channel",
  "ownerId": "user_123",
  "tenantId": "workspace_456",
  "input": {
    "channelUrl": "..."
  }
}
```

RhinoQ:

1. validate input;
2. tạo Task;
3. tạo attempt 1;
4. tạo execution;
5. enqueue runtime;
6. trả task ID và scoped token.

## 8.2. Worker nhận việc

Native runtime:

```text
PostgreSQL claim
→ lease owner/epoch
→ heartbeat
→ start event
```

BullMQ adapter:

```text
BullMQ active event
→ map thành Execution running
→ map Task running
```

## 8.3. Worker báo progress

```ts
await ctx.progress({
  step: "scanning",
  current: 20,
  total: 100,
  message: "Found 20 videos",
});
```

RhinoQ:

1. kiểm tra attempt và fence;
2. cập nhật hot snapshot;
3. coalesce persistent write;
4. phát realtime event;
5. tăng version.

## 8.4. Frontend subscribe

```tsx
const { task, connection, cancel, retry } = useRhinoTask({
  taskId,
  token,
  transport: "auto",   // "sse" | "ws" | "poll" | "auto" | custom
});
```

Hook:

1. fetch snapshot qua `GET /v1/tasks/{id}`;
2. đăng ký `taskId` vào **connection manager dùng chung của tab** (mục 8.11), không tự mở kết nối riêng;
3. nhận snapshot delta;
4. đưa qua reducer theo attempt/version;
5. degrade transport khi cần, theo cấu hình;
6. dừng ở terminal state.

Điểm quan trọng: hook **không sở hữu kết nối**. Nó chỉ sở hữu một subscription. Đây là điều kiện để mục 8.11 hoạt động.

## 8.5. Khi transport chính lỗi

`connection` là một state machine công khai, người dùng đọc được:

```ts
type ConnectionState =
  | { mode: "sse";  status: "live" }
  | { mode: "sse";  status: "reconnecting"; attempt: number }
  | { mode: "poll"; status: "live"; reason: "degraded" | "configured" }
  | { mode: "none"; status: "error"; error: TransportError };
```

Với `transport: "auto"`:

```text
SSE disconnect
→ reconnect với exponential backoff + jitter
→ trong lúc chờ: polling snapshot theo interval
→ SSE lên lại: dừng polling
```

Với `transport: "sse"`:

```text
SSE disconnect
→ reconnect với exponential backoff
→ hết số lần thử: connection.status = "error"
→ KHÔNG tự chuyển sang polling
```

Polling và SSE **không cập nhật state độc lập**. Cả hai đi qua cùng một reducer:

```text
accept khi:
  attempt mới hơn
hoặc
  cùng attempt và version lớn hơn
bỏ khi:
  version nhỏ hơn hoặc bằng
  hoặc state hiện tại đã terminal
```

Vì vậy không có khả năng phân kỳ giữa hai transport — đó là lý do fallback ở đây không phải "đổi công cụ".

## 8.6. Transport phục hồi

```text
Reconnect với Last-Event-ID / offset
→ replay event còn trong buffer
→ nếu gap hoặc buffer hết hạn: fetch snapshot
→ snapshot luôn thắng
→ dừng transport dự phòng
```

Khác biệt so với mô hình buffer-and-replay thuần: **buffer hết hạn không làm mất state**, vì snapshot vẫn nằm trong PostgreSQL. Buffer chỉ là tối ưu, không phải nguồn sự thật.

## 8.7. Retry

```text
attempt 1 failed
→ retry requested
→ attempt 2 created
→ progress reset
→ execution mới
```

Attempt cũ được giữ cho history.

## 8.8. Cancellation

```text
Frontend cancel
→ auth
→ Task cancellation_requested
→ runtime adapter cancel
```

- queued job: remove/cancel;
- active worker: cooperative cancellation;
- Node: AbortSignal;
- Go: context.Context;
- Python: cancellation polling/token.

Developer chỉ viết cleanup nghiệp vụ.

## 8.9. Completion

Worker:

```ts
await ctx.complete({
  resultRef: {
    provider: "app-db",
    key: "scan_result_123",
  },
  summary: {
    total: 100,
    completed: 95,
    failed: 5,
  },
});
```

Verified mode:

```text
complete requested
→ verifier
→ terminal state
```

## 8.10. Kiến trúc Delivery tổng thể

```text
  Browser tab
  ┌──────────────────────────────────────────┐
  │  useRhinoTask(t1) ┐                      │
  │  useRhinoTask(t2) ┼─► SubscriptionStore  │
  │  useRhinoTask(t3) ┘         │            │
  │                             ▼            │
  │                    ConnectionManager     │
  │                    (1 kết nối / tab)     │
  └─────────────────────────┬────────────────┘
                            │  TaskTransport
                            ▼
  ┌──────────────────────────────────────────┐
  │            Delivery Gateway              │
  │  stateless · scale ngang · shard theo    │
  │  hash(taskId)                            │
  │  ┌────────────┐  ┌────────────────────┐  │
  │  │ Coalescer  │  │ Auth / scope check │  │
  │  └────────────┘  └────────────────────┘  │
  └─────────────────────────┬────────────────┘
                            │  Realtime Bus
              ┌─────────────┴─────────────┐
              ▼                           ▼
   Postgres LISTEN/NOTIFY          Redis Pub/Sub
   (deployment nhỏ, tín hiệu)      (deployment lớn, data)
              │                           │
              └─────────────┬─────────────┘
                            ▼
              PostgreSQL — durable truth
```

Bốn thành phần dưới đây là thứ quyết định hệ thống có scale nổi hay không. Bản v1 không có phần nào trong số này.

## 8.11. Connection multiplexing

**Vấn đề.** Nếu mỗi `useRhinoTask` mở một kết nối riêng, màn hình có 20 task đang chạy sẽ cần 20 kết nối. HTTP/1.1 giới hạn 6 connection/domain — task thứ 7 treo vô hạn, không có lỗi, không có timeout rõ ràng. Đây là lỗi rất khó debug và sẽ xuất hiện ở người dùng thật.

**Ràng buộc kỹ thuật phải tôn trọng.** `EventSource` là kênh một chiều. Client **không thể** gửi lệnh subscribe mới lên chính kết nối đó. Bản v2.0 mô tả "gửi lệnh subscribe trên kết nối đang có" — điều đó không thực hiện được với SSE. Đây là lỗi correctness, không phải chi tiết triển khai.

Có bốn mô hình khả thi, và phải chọn dứt khoát:

| Mô hình | Subscribe động | Chi phí | Đánh giá |
|---|---|---|---|
| A. Server-driven theo scope | không cần | thấp | **mặc định** |
| B. Control channel qua POST riêng | có | trung bình | dùng khi cần lọc hẹp |
| C. Reconnect khi tập task đổi | có, chậm | cao khi đổi nhiều | fallback |
| D. WebSocket | có, tức thì | cần hạ tầng WS | transport tùy chọn |

### Mô hình A — Server-driven (mặc định)

**Client không khai báo task nào cả.** Server quyết định đẩy gì dựa trên scope của token.

```text
GET /v1/stream
Authorization: Bearer <token scope owner=user_123, tenant=ws_456>
```

Server đẩy mọi thay đổi của task thuộc scope đó. Client nhận hết, `ConnectionManager` dispatch tới hook nào đang quan tâm, bỏ qua phần còn lại.

Ưu điểm:

- không cần subscribe động — bài toán biến mất thay vì được giải;
- task mới tạo tự động xuất hiện, không cần bước đăng ký;
- authorization đơn giản: một lần kiểm tra scope lúc handshake;
- hợp với Task Center, nơi vốn cần thấy mọi task của user.

Nhược điểm và cách chặn:

- **Over-fetch.** Một tenant có 500 task đang chạy nhưng tab chỉ hiển thị 3. Chặn bằng server-side filter mặc định: chỉ đẩy task **không terminal**, cộng task terminal trong 60 giây gần nhất (để bắt được sự kiện kết thúc).
- **Rò rỉ metadata.** Chỉ đẩy snapshot rút gọn cho task client chưa hỏi; đẩy đầy đủ cho task client đã fetch snapshot.

### Mô hình B — Control channel

Khi mô hình A đẩy quá nhiều, client thu hẹp bằng một request riêng:

```text
GET  /v1/stream                      → trả về connectionId trong event đầu
POST /v1/stream/{connectionId}/subscribe    { "add": ["t9"], "remove": ["t1"] }
```

Gateway ánh xạ `connectionId` sang kết nối đang mở. Trong deployment nhiều node, `connectionId` phải mã hóa node ID hoặc lệnh phải đi qua `RealtimeBus` — nếu không, POST tới node B sẽ không tìm thấy kết nối ở node A.

Đây là chi phí thật, và là lý do mô hình A tốt hơn cho V1.

### Mô hình C — Reconnect có debounce

```text
tập task đổi → chờ 300ms gom thay đổi → reconnect với query mới + Last-Event-ID
```

Đơn giản nhưng mỗi lần mở màn hình mới là một reconnect. Chỉ dùng làm fallback khi mô hình A không áp dụng được (ví dụ share link nhiều task cố định).

### Mô hình D — WebSocket

Subscribe động thật sự, hai chiều, không có mấy vấn đề trên. Nhưng cần hạ tầng hỗ trợ WS và không chạy được trên một số môi trường serverless.

Là **transport tùy chọn** (`transport: "ws"`), không phải mặc định.

### Quyết định

```text
V1:  Mô hình A là mặc định
     Mô hình C cho share link nhiều task
V2:  Mô hình D cho ai cần subscribe động tức thì
     Mô hình B chỉ làm nếu có yêu cầu thật
```

### Client side

```ts
class ConnectionManager {
  private listeners = new Map<TaskID, Set<Listener>>();
  private transport: TaskTransport | null = null;

  subscribe(taskId: TaskID, listener: Listener): Unsubscribe {
    // listener đầu tiên của cả tab → mở transport theo scope token
    // listener tiếp theo → chỉ đăng ký vào map, KHÔNG chạm tới kết nối
    // listener cuối cùng rời đi → đóng transport sau debounce 5s
  }

  private onMessage(envelope: Envelope) {
    // dispatch theo envelope.taskId; không có listener thì bỏ qua
  }
}
```

Điểm mấu chốt: **thêm hook không sinh ra thao tác mạng nào.** Đó là điều mô hình A mua được.

**Hệ quả lên thiết kế token.** Một kết nối phục vụ nhiều task nên token không thể scope theo một task:

```text
scope: { owner: "user_123", tenant: "ws_456" }     // mặc định, cho mô hình A
scope: { tasks: ["task_1", "task_2", "task_3"] }   // cho share link, mô hình C
```

Mục 16.7 được cập nhật theo hướng này.

**Giới hạn cần công bố:** một tab đẩy tối đa `maxTasksPerConnection` (đề xuất 200 task không terminal). Vượt thì server ngừng đẩy task mới và gửi event `stream.scope_truncated`; client chuyển sang polling cho phần dư. Im lặng cắt bớt là lỗi tệ hơn.

## 8.12. Fan-out giữa các node

**Vấn đề.** Gateway phải stateless và scale ngang. Worker báo progress qua node A, client đang cắm vào node B.

**Hai adapter sau cùng một port `RealtimeBus`:**

### PostgreSQL LISTEN/NOTIFY

Cho deployment nhỏ và library mode. Không cần thêm hạ tầng.

Ràng buộc phải tôn trọng:

- payload `NOTIFY` giới hạn 8000 byte;
- mỗi node giữ một connection riêng cho `LISTEN`, không dùng chung pool;
- `NOTIFY` chỉ gửi sau khi transaction commit — đúng với mô hình snapshot-first;
- không có replay; node vừa khởi động không nhận được gì đã bỏ lỡ.

Vì vậy: **dùng NOTIFY làm tín hiệu, không phải kênh dữ liệu.**

```json
{ "taskId": "task_123", "version": 42 }
```

Gateway nhận tín hiệu → đọc snapshot từ Postgres → coalesce → đẩy cho client. Một round-trip thêm, nhưng đúng và không giới hạn payload.

### Redis Pub/Sub

Cho deployment lớn. Throughput cao hơn, payload không giới hạn thực tế, và đây là lý do Redis là first-class hot layer trong mục 13.2.

Ở mode này gateway có thể đẩy thẳng delta mà không đọc lại Postgres, với điều kiện delta mang đủ `attempt` + `version` để reducer xử lý được.

### Chọn adapter

```yaml
rhinoq:
  realtime:
    bus: notify   # notify | redis
```

Mặc định `notify`. Bật `redis` khi vượt ngưỡng benchmark ở mục 28.

## 8.13. Coalescing

**Đây là điều kiện sống còn khi scale, và là chỗ tận dụng được đặc tính riêng của progress.**

Progress event có tính chất: **chỉ giá trị mới nhất mới quan trọng**. Task xử lý 10.000 item báo progress 10.000 lần; client chỉ cần thấy vài chục lần. Bỏ event trung gian không mất thông tin.

Coalescing xảy ra ở ba tầng:

```text
Tầng 1 — Worker SDK
  throttleMs + minimumDelta trước khi gửi lên server

Tầng 2 — Persistence (mục 13.3)
  coalesce write xuống PostgreSQL mỗi 1–2 giây
  trừ các mốc bắt buộc persist ngay

Tầng 3 — Delivery Gateway
  giữ latest snapshot per taskId trong buffer
  flush theo tick 100–250 ms
```

Quy tắc bắt buộc:

- **Terminal state không bao giờ bị coalesce.** `completed`, `failed`, `cancelled`, `needs_attention` phải đi ngay.
- **Step transition không bị coalesce.** Người dùng cần thấy đổi bước.
- **Progress trong cùng một step thì coalesce thoải mái.**
- **Stream chunk không bao giờ coalesce** (mục 6.9).

Tận dụng đúng điều này giảm tải một đến hai bậc độ lớn so với đẩy thẳng.

## 8.14. Sharding

Khi số subscription vượt khả năng của một node:

```text
shard = hash(taskId) % shardCount
```

Mỗi gateway node chỉ `LISTEN`/`SUBSCRIBE` các shard nó phụ trách. Client được route tới đúng node qua consistent hashing ở load balancer, hoặc qua redirect ở lần handshake đầu.

Không làm ở V1. Nhưng envelope và channel naming phải chừa chỗ:

```text
rhinoq:shard:{n}:task:{taskId}
```

## 8.15. Backpressure phía delivery

Khác với backpressure phía execution ở mục 10.9.

- Client chậm hơn tốc độ sinh event → buffer per-connection có giới hạn; vượt thì **bỏ event trung gian và gửi snapshot đầy đủ** thay vì đóng kết nối.
- Reconnect storm sau khi gateway restart → jitter bắt buộc phía client, thêm rate limit trên endpoint snapshot.
- Một task được nhiều client theo dõi → coalesce một lần, fan-out N lần; không coalesce riêng cho từng client.

## 8.16. Đa tab và đa thiết bị

- Nhiều tab cùng một user: mỗi tab một kết nối riêng. Không dùng `BroadcastChannel` để chia sẻ giữa tab ở V1 — phức tạp, lợi ích nhỏ.
- Tab vào background: transport có thể bị hệ điều hành giết mà không phát `error`. Client phải có heartbeat phía ứng dụng, và fetch snapshot lại khi `visibilitychange` trở về `visible`.
- Đa thiết bị: không cần cơ chế riêng. Snapshot-first cho phép mọi thiết bị hội tụ về cùng một state mà không cần session chung.

## 8.17. Snapshot và hot state không được lệch nhau

> Lỗ hổng trong bản v2.0. Mục 13.3 nói progress được coalesce, chỉ persist xuống PostgreSQL mỗi 1–2 giây. Nhưng Redis đã phát progress 60 trong khi PostgreSQL mới có 55. Người dùng reload trang → snapshot API trả 55 → **UI tụt lùi**. Điều này phá vỡ đúng lời hứa cốt lõi "reload vẫn ra đúng state".

### Nguồn gốc vấn đề

Có hai nơi giữ state và hai nơi cấp version. Phải chốt cả hai.

### Quyết định 1 — Version được cấp ở một nơi duy nhất

`version` là bộ đếm đơn điệu tăng, cấp tại **hot layer** khi có Redis, tại **PostgreSQL** khi không có.

```text
Có Redis:      INCR rhinoq:task:{id}:version   → nguồn cấp version
Không Redis:   UPDATE ... SET version = version + 1 RETURNING version
```

Không bao giờ có hai bộ đếm song song. Version đã phát ra không bao giờ được cấp lại.

### Quyết định 2 — Snapshot API là merge, không phải đọc thuần PostgreSQL

```text
GET /v1/tasks/{id}
  1. đọc durable snapshot từ PostgreSQL          (version = 55)
  2. đọc hot overlay từ Redis nếu có             (version = 60)
  3. nếu hot.version > durable.version → merge overlay lên trên
  4. trả về snapshot với version = 60 và cờ durability
```

```json
{
  "taskId": "task_123",
  "version": 60,
  "progress": { "mode": "count", "current": 60, "total": 100 },
  "durability": "hot",
  "durableVersion": 55
}
```

`durability` nhận `durable` hoặc `hot`. Trường này công khai để client và Task Inspector biết mình đang nhìn state nào.

### Quyết định 3 — Cái gì được phép chỉ nằm ở hot

Chỉ **progress trong cùng một step** được phép chưa persist. Mọi thứ khác persist đồng bộ trước khi phát event:

```text
Chỉ hot được:    progress current/total, message
Phải durable:    lifecycle, outcome, health, attempt, step transition,
                 result, cancellation, terminal state
```

Nghĩa là: mất Redis thì mất nhiều nhất là vài giây progress, **không bao giờ mất trạng thái có ý nghĩa**.

### Quyết định 4 — Hot layer chết thì degrade sạch

```text
Redis unavailable
→ snapshot API trả durable state, durability = "durable"
→ progress có thể tụt tối đa bằng khoảng coalesce (1–2s)
→ client chấp nhận: reducer bỏ qua version thấp hơn state đang có trên màn hình
→ client mới vào: thấy 55 thay vì 60 — chấp nhận được, vì chênh lệch có giới hạn
```

Client đang mở sẵn **không** bị tụt, vì reducer chặn version nhỏ hơn. Chỉ client mới vào mới thấy state cũ hơn tối đa vài giây.

### Bất biến bổ sung cho mục 17.3

```text
5. version đơn điệu tăng trên toàn hệ thống cho một task
6. snapshot.version >= mọi version đã phát qua transport
7. durableVersion <= version, luôn luôn
8. state có ý nghĩa (không phải progress) luôn có durableVersion == version
```

Bất biến 8 là thứ làm cho "reload ra đúng state" đúng theo nghĩa mạnh.

## 8.18. Command semantics và thứ tự ưu tiên

> Bản v2.0 xử lý tốt thứ tự **event** theo attempt/version, nhưng chưa định nghĩa thứ tự **command**. Đây là hai bài toán khác nhau: event là chuyện đã rồi, command là ý định có thể xung đột.

### Mọi command có định danh và điều kiện

```json
{
  "commandId": "cmd_9f2a",
  "taskId": "task_123",
  "expectedAttempt": 2,
  "expectedVersion": 42
}
```

- `commandId` bảo đảm idempotency: cùng một ID chỉ tạo đúng một hiệu ứng nghiệp vụ, gọi lại trả về kết quả lần đầu.
- `expectedAttempt` bắt buộc với command từ worker. Sai attempt → reject với `stale_attempt`.
- `expectedVersion` tùy chọn, dùng cho optimistic concurrency từ UI.

### Bảng ưu tiên chính thức

| Trạng thái hiện tại | Command | Kết quả |
|---|---|---|
| `running` | `cancel` | `cancellation_requested` |
| `cancellation_requested` | `complete` | theo `cancellationPolicy` — xem dưới |
| `cancellation_requested` | `fail` | `terminal + cancelled` (fail bị nuốt, cancel thắng) |
| `terminal` | `cancel` | no-op, trả 200 với state hiện tại |
| `terminal + failed` | `retry` | tạo attempt mới |
| `terminal + succeeded` | `retry` | reject `already_succeeded` trừ khi `force: true` |
| `running` attempt 2 | `fail` attempt 1 | reject `stale_attempt`, ghi audit |
| `terminal` | `complete` lặp lại | idempotent success, trả state hiện tại |
| `queued` | `cancel` | huỷ execution, `terminal + cancelled` |
| `pending_dispatch` | `cancel` | `terminal + cancelled`, đánh dấu outbox record là abandoned |
| bất kỳ | `retry` gọi hai lần cùng `commandId` | một attempt duy nhất |
| bất kỳ | `retry` gọi hai lần khác `commandId` | attempt thứ hai reject nếu attempt trước chưa terminal |

### Cancel gặp Complete — không có đáp án đúng chung

Worker hoàn thành ngay sau khi người dùng bấm cancel. Task là `succeeded` hay `cancelled`?

- Task xuất video: công việc đã xong, tính tiền rồi → **completion wins**.
- Task gửi chiến dịch email: người dùng bấm cancel để dừng gửi → **request wins**, và hệ quả nghiệp vụ phải được compensate.

Vì vậy đây là policy trong TaskDefinition:

```ts
cancellation: {
  policy: "completion-wins",   // hoặc "request-wins"
  graceMs: 5000,               // completion tới trong khoảng này vẫn được chấp nhận
}
```

Mặc định `completion-wins` — vì việc đã làm xong thì bỏ đi thường lãng phí hơn.

Với `request-wins`, khi completion tới sau cancel:

```text
task terminal + cancelled
health = healthy
summary.discardedResult = <resultRef>
event task.result.discarded
```

Result không bị xóa ngay, để operator có thể phục hồi. Retention theo `resultDays`.

### Webhook đến sau timeout

```text
provider operation đã timeout → operation.status = timed_out
webhook complete tới sau
→ nếu task chưa terminal: chấp nhận, chuyển operation sang completed
→ nếu task đã terminal: ghi nhận, không đổi task,
   phát event provider.late_completion, health = needs_attention
```

Không im lặng bỏ. Late completion là tín hiệu polling policy đang sai.

---

# 9. Partial Results, Task Items và Streams

## 9.1. Vì sao cần Task Item?

Một task batch có thể tạo kết quả dần:

```text
Scan 100 video
→ video 1 có link
→ video 2 đang tải
→ video 3 lỗi
```

Frontend không nên chờ tất cả hoàn tất.

## 9.2. API item

```http
GET /v1/tasks/{taskId}/items?limit=50&cursor=...
GET /v1/tasks/{taskId}/items/{itemKey}
POST /v1/tasks/{taskId}/items/{itemKey}/retry
POST /v1/tasks/{taskId}/items/{itemKey}/cancel
```

## 9.3. Event item

```json
{
  "type": "task.item.changed",
  "taskId": "task_123",
  "itemKey": "video_456",
  "itemVersion": 7,
  "summary": {
    "status": "completed",
    "thumbnailUrl": "...",
    "resultRef": "video_456"
  }
}
```

Không gửi raw 10.000 field.

## 9.4. Completion policy

```ts
completion: {
  policy: "allow-partial",
  minimumSuccessRate: 0.9,
}
```

Hỗ trợ:

- `all-succeeded`;
- `allow-partial`;
- `fail-fast`;
- `minimum-threshold`;
- `manual-finalize`.

## 9.5. Retry từng item

Không retry toàn bộ task khi chỉ một video lỗi.

```text
Video 3 attempt 1 failed
Video 3 attempt 2 running
```

## 9.6. Stream channel

> Phần này không có trong bản v1. Nó là bổ sung bắt buộc, không phải mở rộng tùy chọn.

Năm 2026, phần lớn tính năng long-running hướng người dùng là AI generation. Người dùng cần thấy token chảy ra, không chỉ thấy phần trăm. Trigger.dev có `useRealtimeRunWithStreams`; Inngest có `publish` + `useRealtime`. Không có stream là mất use case lớn nhất.

Stream là kênh **riêng biệt** với snapshot, vì ngữ nghĩa ngược nhau (mục 6.9).

### Worker API

```ts
const stream = ctx.stream("answer");        // đặt tên kênh
for await (const chunk of llm.stream(prompt)) {
  await stream.write(chunk);                 // append-only, không coalesce
}
await stream.close();
```

Một task có thể có nhiều stream:

```ts
ctx.stream("answer")      // token trả lời
ctx.stream("reasoning")   // chain of thought
ctx.stream("logs")        // log dòng
```

### Frontend API

```tsx
const { chunks, isStreaming } = useRhinoTaskStream(taskId, "answer", { token });
const text = chunks.join("");
```

Hoặc lấy cả hai qua một hook:

```tsx
const { task, streams } = useRhinoTask(taskId, {
  token,
  streams: ["answer"],
});
```

### Ngữ nghĩa

| Thuộc tính | Giá trị |
|---|---|
| Thứ tự | đảm bảo trong một stream, không đảm bảo giữa các stream |
| Mất chunk | không chấp nhận được |
| Trùng chunk | client dedupe theo offset |
| Phục hồi | replay từ offset gần nhất client đã nhận |
| Coalescing | cấm |
| Lưu trữ | ring buffer, TTL cấu hình được |

## 9.7. Lưu trữ và phục hồi stream

```text
Redis Stream / List:  rhinoq:stream:{taskId}:{name}
  - append với offset tăng dần
  - TTL mặc định 1 giờ, cấu hình được
  - XRANGE từ offset để replay

PostgreSQL (tùy chọn):
  rhinoq_task_streams — metadata: name, status, chunk_count, closed_at
  archive vào object storage nếu cần giữ lâu
```

Không có Redis thì stream degrade về chế độ **buffer-in-gateway**: giữ trong bộ nhớ node, không phục hồi được sau restart. Phải công bố rõ giới hạn này, không được im lặng.

Reconnect:

```text
GET /v1/tasks/{id}/streams/{name}?fromOffset=1240
→ replay các chunk từ 1240
→ chuyển sang live
```

Nếu offset đã rơi khỏi buffer:

```json
{ "error": "stream_offset_expired", "availableFrom": 1900 }
```

Client tự quyết định: hiển thị phần thiếu là `[...]`, hoặc lấy full text từ `resultRef` nếu task đã completed. **Không giả vờ như không mất gì.**

## 9.8. Quan hệ giữa stream và snapshot

Hai kênh độc lập nhưng cùng thuộc một task:

```text
Task task_123
├── snapshot  → status, progress, step, summary   (latest-wins)
├── items     → item lifecycle                    (latest-wins per item)
└── streams
    ├── "answer"    → chunk 0..N                  (append-only)
    └── "reasoning" → chunk 0..M                  (append-only)
```

Quy tắc:

- Task chuyển terminal thì mọi stream tự động `closed`.
- Retry tạo attempt mới thì stream của attempt cũ được giữ cho history nhưng không phát nữa; stream mới có `attempt` riêng.
- Kết quả cuối cùng nên được ghi vào `resultRef`, không phụ thuộc vào việc client có nhận đủ chunk hay không.

Điều cuối cùng quan trọng: **stream là để hiển thị, `resultRef` mới là để tin.**

---

# 10. Xử lý payload rất lớn

## 10.1. Ba lớp dữ liệu

### Raw

Toàn bộ response provider:

```text
S3/raw/tasks/{taskId}/{itemKey}.json.gz
```

### Normalized

Các field business thực sự dùng:

```json
{
  "videoId": "...",
  "title": "...",
  "thumbnailUrl": "...",
  "downloadUrl": "..."
}
```

### View Summary

Các field cần hiển thị list:

```json
{
  "id": "...",
  "title": "...",
  "thumbnailUrl": "...",
  "status": "completed"
}
```

## 10.2. Không truyền raw qua SSE

SSE event mặc định giới hạn nhỏ.

Đề xuất:

```text
SSE event max:          32 KB
Task snapshot max:     128 KB
Item summary max:       16 KB
Inline result max:      64 KB
List page max:         100 items
```

Payload lớn hơn phải dùng `ResultRef`.

## 10.3. Projection API

```http
GET /tasks/{id}/items?view=list
GET /tasks/{id}/items/{key}?view=detail
GET /tasks/{id}/items/{key}/raw
```

Raw endpoint chỉ cho quyền debug/admin hoặc trả signed URL.

## 10.4. Cursor pagination

Không trả tất cả items.

```http
GET /tasks/task_123/items?limit=30&cursor=abc
```

## 10.5. Frontend virtualization

SDK/component nên khuyến nghị hoặc tích hợp virtual list cho dữ liệu lớn.

## 10.6. Progress throttling

```ts
ctx.item(id).progress(value, {
  throttleMs: 500,
  minimumDelta: 2,
});
```

## 10.7. Event batching

Gom thay đổi trong cửa sổ 100–250 ms:

```json
{
  "type": "task.items.changed",
  "items": [
    { "key": "a", "status": "completed" },
    { "key": "b", "progress": 50 }
  ]
}
```

## 10.8. Worker memory safety

Không giữ toàn bộ raw result trong array.

```text
fetch one item
→ normalize
→ persist raw
→ persist business data
→ publish summary
→ release memory
```

## 10.9. Backpressure

Hỗ trợ:

```text
global concurrency
queue concurrency
provider concurrency
tenant concurrency
resource group
```

---

# 11. Provider Operations

## 11.0. Ranh giới — Provider Ops không phải platform thứ hai

Provider Operations là lợi thế cạnh tranh rõ nhất của RhinoQ (mục 5.2). Chính vì vậy nó dễ phình thành một orchestration platform riêng nằm cạnh Task Core — và lúc đó RhinoQ bị chia thành hai sản phẩm.

Chốt vị trí:

```text
Task
└── Attempt
    └── Execution
        └── 0..N ProviderOperation
```

> **ProviderOperation là một execution primitive thuộc Task, không phải một workflow platform độc lập.**

Không bao giờ tồn tại `ProviderOperation` không có `Task`. Không có API tạo provider operation trực tiếp.

### Trong phạm vi

```text
start · poll · webhook · timeout · retry · rate limit
circuit breaker · fallback · idempotency · cost · normalize · complete
```

### Ngoài phạm vi, và phải giữ nguyên như vậy

```text
DAG builder
conditional branching
human approval workflow
long-lived business orchestration
saga engine tổng quát
```

Mỗi thứ trong danh sách thứ hai đều hấp dẫn và đều là cách RhinoQ biến thành Temporal thứ hai, tệ hơn Temporal. Nếu người dùng cần chúng, câu trả lời đúng là "dùng Temporal/Restate cho phần đó, RhinoQ lo phần user-facing".

## 11.1. Mục tiêu

Giảm phần backend phải tự viết khi làm việc với external provider.

RhinoQ bao:

- start request;
- provider request ID;
- polling;
- webhook;
- timeout;
- retry;
- rate limit;
- circuit breaker;
- fallback;
- idempotency;
- cost/quota;
- raw result;
- normalization pipeline;
- partial items;
- progress delivery.

Backend vẫn phải định nghĩa API đặc thù và mapping nếu chưa có connector.

## 11.2. Provider adapter

```ts
const provider = rhinoq.provider({
  name: "video-scanner",

  start: async (input) => {
    const response = await client.startScan(input);
    return {
      externalId: response.requestId,
      state: "pending",
    };
  },

  poll: async (operation) => {
    const response = await client.getStatus(operation.externalId);
    return {
      state: mapStatus(response.status),
      progress: response.progress,
      raw: response,
    };
  },

  cancel: async (operation) => {
    await client.cancel(operation.externalId);
  },

  normalize: async (raw) => normalizeVideos(raw),
});
```

## 11.3. Polling policy

```ts
polling: {
  initialDelayMs: 2000,
  strategy: "exponential",
  maximumDelayMs: 30000,
  timeoutMs: 600000,
  jitter: true,
}
```

## 11.4. Webhook + polling fallback

```text
polling đang chạy
→ webhook tới
→ operation completed
→ hủy scheduled poll
```

Webhook duplicate được deduplicate.

## 11.5. Rate limit

```ts
limits: {
  globalConcurrency: 5,
  requestsPerSecond: 2,
  perTenantConcurrency: 1,
}
```

## 11.6. Circuit breaker

Theo dõi:

- timeout rate;
- error rate;
- latency;
- rate limited count.

Provider unhealthy có thể:

- pause;
- fallback;
- fail fast;
- queue until recovery.

## 11.7. Fallback provider

```ts
providers: [primary, backup],
fallback: {
  on: ["timeout", "unavailable", "rate_limited"],
  maximumProviders: 2,
}
```

## 11.8. Idempotency và chi phí

```ts
idempotencyKey: `scan:${channelId}:${scanVersion}`

budget: {
  maximumAttempts: 3,
  maximumCost: 0.10,
}
```

## 11.9. Mapping và normalization

RhinoQ không tự hiểu field business.

Hỗ trợ ba mức:

### Declarative

```ts
mapping: {
  id: "$.aweme_id",
  title: "$.desc",
  username: "$.author.unique_id",
  thumbnailUrl: "$.video.cover.url_list[0]",
}
```

### Transform

```ts
durationSeconds: {
  from: "$.video.duration",
  transform: value => value / 1000,
}
```

### Custom normalizer

```ts
normalize(raw) {
  return customBusinessMapping(raw);
}
```

## 11.10. Mapping Workbench

Mục tiêu:

- dán sample response;
- duyệt JSON tree;
- chọn path;
- preview output;
- test nhiều samples;
- validate schema;
- version mapping;
- báo field missing.

Đây là module sau MVP, không bắt buộc V1.

---

# 12. Phân vai dữ liệu

## 12.1. RhinoQ lưu

- task lifecycle;
- execution;
- attempts;
- progress snapshot;
- step;
- item status;
- item summary nhỏ;
- result reference;
- provider operation;
- raw result reference;
- event;
- audit;
- ownership;
- permissions;
- verification evidence.

## 12.2. Application database lưu

- video;
- product;
- customer;
- order;
- report;
- các business entities;
- dữ liệu normalize đầy đủ.

## 12.3. Object storage lưu

- raw JSON lớn;
- video;
- ảnh;
- report file;
- export;
- logs lớn;
- provider payload archive.

---

# 13. PostgreSQL và Redis

## 13.1. PostgreSQL

Nguồn sự thật bền vững:

- tasks;
- executions;
- attempts;
- terminal states;
- ownership;
- results;
- event history quan trọng;
- audit;
- Effect Ledger;
- Findings;
- verification.

## 13.2. Redis

Hot path tùy chọn nhưng first-class:

- realtime fan-out;
- pub/sub;
- progress buffer;
- cache snapshot;
- rate limit;
- connection coordination;
- BullMQ runtime;
- high-volume dispatch;
- short-lived event stream.

## 13.3. Không ghi mọi progress vào PostgreSQL

Coalesce:

```text
Worker: 31, 32, 33, 34, 35
Redis realtime: có thể phát nhiều
PostgreSQL: persist 31 → 35 hoặc mỗi 1–2 giây
```

Persist ngay:

- started;
- step transition;
- attempt failed;
- cancellation;
- completed;
- failed;
- verified result.

## 13.4. Deployment modes

Bốn mode, xếp theo mức độ hạ tầng tăng dần. **Mode 1 là bổ sung so với bản v1 và là mode quan trọng nhất cho adoption.**

### Mode 1 — Library mode (nhúng vào ứng dụng)

Không có service riêng. RhinoQ là một module trong app, dùng chính PostgreSQL của app.

```ts
// app.module.ts
import { RhinoQModule } from "@rhinoq/nestjs";

@Module({
  imports: [
    RhinoQModule.forRoot({
      datasource: existingDataSource,   // dùng lại connection của app
      schema: "rhinoq",                 // schema riêng, không đụng bảng app
      realtime: { bus: "notify" },      // LISTEN/NOTIFY, không cần Redis
      auth: { resolve: (req) => req.user },
    }),
  ],
})
export class AppModule {}
```

Gateway chạy như route trong chính app:

```ts
app.use("/rhinoq", rhinoq.gateway());
```

**Vì sao mode này quan trọng.** Nhóm A trong mục 4.1 — solo dev và team nhỏ — chính là nhóm ghét thêm một service. Nếu adoption đòi hỏi `docker compose up rhinoq` cộng một database riêng thì RhinoQ nặng ngang Hatchet mà kém mature hơn. Library mode là cách duy nhất để "tích hợp dưới một buổi" thành sự thật.

Đây cũng là mô hình DBOS đã chứng minh: cài như library, state trong Postgres sẵn có, không cluster, không orchestration server.

Giới hạn phải công bố:

- gateway scale cùng app, không scale độc lập;
- fan-out qua LISTEN/NOTIFY, giới hạn theo mục 8.12;
- stream không phục hồi được sau restart nếu không có Redis;
- không phù hợp khi có nhiều service cùng cần một Task Center chung.

### Mode 2 — Service mode, tối giản

```yaml
rhinoq:
  postgres: postgres://...
  realtime:
    bus: notify
```

Một container, một database. Dùng khi nhiều service cùng cần chung một task layer.

### Mode 3 — Service mode, scaled realtime

```yaml
rhinoq:
  postgres: postgres://...
  redis: redis://...
  realtime:
    bus: redis
    shards: 4
```

Gateway scale ngang, fan-out qua Redis, stream có buffer bền hơn.

### Mode 4 — Existing BullMQ

```yaml
rhinoq:
  postgres: postgres://...
  redis: redis://...
  realtime:
    bus: redis
  runtime: bullmq
  bullmq:
    queues: ["scan", "export"]
    liveness:
      strategy: adapter-heartbeat   # xem mục 14.6
      stalledAfterMs: 60000
```

### Chọn mode

```text
1 service, ít task, không có Redis        → Mode 1
Nhiều service, chưa cần scale realtime    → Mode 2
Nhiều client đồng thời, có stream         → Mode 3
Đang có BullMQ và không muốn migrate      → Mode 4
```

---

# 14. Runtime strategy

## 14.1. RhinoQ Native Runtime

Nên giữ và phát triển vì repository hiện đã có:

- transactional enqueue;
- claim;
- lease;
- heartbeat;
- retry;
- delay;
- cancellation;
- admission;
- rate limit;
- poison protection;
- fencing;
- graceful shutdown;
- Effect Ledger;
- guarded replay.

Native mode có guarantee mạnh nhất:

- atomic Task + Execution;
- fenced progress;
- native cancellation;
- attempt consistency;
- verified completion;
- durable history.

## 14.2. BullMQ adapter

Là kênh adoption.

Map:

```text
waiting → queued
active → running
progress → progress
failed + retry left → retrying
failed terminal → failed
completed → completion requested
```

Limit cần công khai:

- fencing yếu hơn;
- atomic task/job creation không mặc định;
- cancellation phụ thuộc BullMQ worker;
- job retention phụ thuộc Redis;
- external execution không có native lease RhinoQ.

## 14.3. Generic HTTP runtime

Bất kỳ ngôn ngữ nào:

```http
POST /tasks/{id}/start
POST /tasks/{id}/progress
POST /tasks/{id}/complete
POST /tasks/{id}/fail
GET  /tasks/{id}/cancellation
```

## 14.4. Đa ngôn ngữ

Roadmap SDK:

```text
Node first
Python second
Go client
Java later
```

Core protocol không phụ thuộc NestJS.

## 14.5. Đa database

Không build nhiều native SQL backends ngay.

- PostgreSQL production backend;
- in-memory test backend;
- SQLite local/demo có giới hạn;
- MySQL chỉ sau demand rõ.

Application có thể dùng MongoDB/MySQL; RhinoQ vẫn chạy PostgreSQL riêng.

## 14.6. Hợp đồng liveness cho external runtime

> Đây là câu hỏi đầu tiên mọi người sẽ hỏi khi nghe "runtime-agnostic": *worker BullMQ của tôi bị OOM kill, RhinoQ biết bằng cách nào?*
>
> Bản v1 không trả lời. Không trả lời được thì "giữ nguyên queue của bạn" là lời hứa rỗng.

### Vấn đề

Với Native Runtime, RhinoQ sở hữu lease và heartbeat nên phát hiện worker chết là chuyện nội bộ. Với external runtime, RhinoQ **không kiểm soát vòng đời worker**. Task có thể mắc kẹt ở `running` vĩnh viễn.

### Ba chiến lược, xếp theo độ mạnh

#### A. Adapter heartbeat (mặc định, mạnh nhất trong các lựa chọn external)

SDK phía worker gửi heartbeat định kỳ như một phần của `ctx`:

```ts
rhinoq.attachWorker(bullmqWorker, {
  heartbeatIntervalMs: 15000,
});
```

RhinoQ đánh dấu execution `stalled` nếu quá `stalledAfterMs` không nhận heartbeat.

```text
last_heartbeat_at + stalledAfterMs < now()
→ execution.status = stalled
→ task.status = needs_attention
→ event task.stalled
```

Yêu cầu: người dùng phải gắn adapter. Đây là mức tích hợp Level 0 trong mục 6.5, chi phí một dòng code.

#### B. Runtime introspection (bổ sung, không thay thế)

Adapter hỏi trực tiếp runtime:

```ts
// BullMQ
const job = await queue.getJob(externalId);
const state = await job.getState();   // waiting | active | completed | failed
```

Reconciler chạy định kỳ, đối chiếu Task đang `running` với state thật của runtime. Bắt được trường hợp job biến mất khỏi Redis hoặc đã `failed` mà event không tới.

Giới hạn phải công bố: BullMQ có `stalled` riêng của nó và job retention phụ thuộc Redis. Job bị dọn khỏi Redis thì introspection trả `null` — khi đó RhinoQ coi là `unknown`, không tự kết luận `failed`.

#### C. Timeout tuyệt đối (lưới an toàn cuối)

```ts
tasks.create({ type: "scan", maxDurationMs: 30 * 60 * 1000 });
```

Quá hạn thì `needs_attention`, không tự động `failed`. Lý do: RhinoQ không biết chắc worker đã chết hay chỉ chậm, và đánh dấu sai một task đã thành công là lỗi nặng hơn để nó treo.

### State mới cần thêm

```text
Execution status:  stalled
Task status:       (dùng lại) needs_attention
Event type:        task.stalled, task.execution.orphaned
```

### Bảng công bố guarantee

Bảng này phải nằm trong README, không giấu trong docs:

| | Native Runtime | BullMQ adapter | Generic HTTP |
|---|---|---|---|
| Atomic task + execution | có | không | không |
| Fenced progress | có | yếu | yếu |
| Phát hiện worker chết | lease + heartbeat | heartbeat + introspection | heartbeat |
| Cancellation | native | phụ thuộc worker | cooperative |
| Task history sống lâu hơn queue retention | có | có | có |
| Exactly-once effect | có (Effect Ledger) | không | không |

Nói thẳng về giới hạn là lợi thế, không phải điểm yếu. Người dùng chọn adapter mode vì họ đã chấp nhận đánh đổi đó rồi.

### Bảng này phải là code, không phải markdown

Viết tay bảng guarantee thì tài liệu sẽ lệch với thực tế trong vòng vài tháng. Biến nó thành contract mà adapter tự khai:

```ts
interface RuntimeCapabilities {
  progress:        "native" | "instrumented" | "none";
  cancellation:    "native" | "cooperative" | "none";
  liveness:        "lease" | "heartbeat" | "introspection" | "timeout";
  atomicDispatch:  boolean;
  resultRecovery:  boolean;
  retryGranularity: "task" | "execution" | "item";
  streaming:       boolean;
}
```

```ts
// BullMQ adapter khai
{
  progress: "instrumented",
  cancellation: "cooperative",
  liveness: "heartbeat",
  atomicDispatch: false,
  resultRecovery: true,
  retryGranularity: "task",
  streaming: true,
}
```

Nhờ vậy:

- **frontend không hiện nút Cancel** nếu runtime khai `cancellation: "none"` — nút không hoạt động tệ hơn không có nút;
- Task Inspector hiển thị guarantee thực tế của từng task, không phải guarantee lý thuyết;
- SDK cảnh báo khi TaskDefinition bật `capabilities.streaming` mà runtime khai `streaming: false`;
- adapter cộng đồng có **conformance test** chung: mỗi giá trị capability tương ứng một bộ test bắt buộc pass;
- bảng trong README được sinh tự động từ capability của các adapter chính thức.

`GET /v1/runtimes` trả về capability của mọi runtime đã đăng ký, để frontend đọc lúc khởi tạo.

## 14.7. Consistency boundary giữa Task và queue

> Lỗ hổng nghiêm trọng nhất của adapter mode trong bản v2.0. PostgreSQL và Redis không nằm chung một transaction được, nên có hai kịch bản hỏng:
>
> ```text
> Tạo Task trong PostgreSQL OK → enqueue BullMQ lỗi
> → Task tồn tại nhưng không có job, treo ở queued vĩnh viễn
>
> Enqueue BullMQ OK → link Task lỗi
> → job chạy nhưng RhinoQ không biết, không ai theo dõi được
> ```

RhinoQ **không thể** hứa atomic dispatch với runtime ngoài. Nhưng có thể hứa điều mạnh hơn "best effort": **eventual linking có kiểm chứng, và phát hiện được mọi trạng thái mồ côi.** Đây chính là chỗ RhinoQ tạo thêm giá trị so với việc tự viết.

### Protocol dispatch

```text
1. BEGIN
     INSERT rhinoq_tasks (lifecycle = 'queued', substate = 'pending_dispatch')
     INSERT rhinoq_dispatch_outbox (task_id, runtime, payload, idempotency_key)
   COMMIT                                    ← atomic trong PostgreSQL

2. Dispatcher đọc outbox
     enqueue vào BullMQ với jobId = idempotency_key
                                             ← idempotent, chạy lại an toàn

3. BEGIN
     UPDATE rhinoq_executions SET external_id = ..., status = 'dispatched'
     UPDATE rhinoq_dispatch_outbox SET status = 'sent'
     UPDATE rhinoq_tasks SET substate = 'queued'
   COMMIT
```

Bước 2 chạy lại được vì `jobId` cố định — BullMQ từ chối job trùng ID, không tạo job thứ hai.

### Bảng outbox

```text
rhinoq_dispatch_outbox
  id
  task_id
  execution_id
  runtime
  idempotency_key        UNIQUE
  payload_json
  status                 pending | sent | failed | abandoned
  attempt
  next_retry_at
  last_error_json
  created_at
  sent_at
```

### Reconciler

Chạy định kỳ, xử lý bốn trường hợp:

| Triệu chứng | Xử lý |
|---|---|
| `pending_dispatch` quá `dispatchTimeoutMs` | thử lại; hết số lần → `needs_attention` + `dispatch_failed` |
| Outbox `sent` nhưng execution chưa có `external_id` | introspect runtime theo `idempotency_key` để bind lại |
| Job tồn tại trong runtime nhưng không có Task | **orphan job** — ghi log, phát cảnh báo, không tự xóa |
| Task `running` nhưng job không còn trong runtime | xem 14.6, chuyển `stalled` |

### Unique external execution reference

```sql
CREATE UNIQUE INDEX ON rhinoq_executions (runtime, external_id)
  WHERE external_id IS NOT NULL;
```

Bất biến: **một external execution không bao giờ thuộc hai task.** Đây là bất biến thứ chín, phải có test riêng.

### Dead letter

Dispatch thất bại quá số lần → `rhinoq_dispatch_dlq`, task chuyển `needs_attention` với `dispatch_failed`. Operator Console cho phép retry thủ công hoặc abandon.

## 14.8. Khi chính RhinoQ ngừng hoạt động

> Đây là câu hỏi người dùng production hỏi ngay, và bản v2.0 không trả lời. Nếu RhinoQ down làm business worker ngừng chạy thì toàn bộ định vị "your queue stays" sụp đổ — RhinoQ vô tình trở thành single point of failure cho chính thứ nó hứa không đụng vào.

### Nguyên tắc

> **Business workload không bao giờ phụ thuộc vào tính sẵn sàng của RhinoQ.**
>
> RhinoQ mất khả năng *quan sát* và *điều khiển*, không mất khả năng *thực thi*.

### Hành vi theo từng thao tác

| Thao tác | Khi RhinoQ down |
|---|---|
| BullMQ job đang chạy | **tiếp tục bình thường**, không bị ảnh hưởng |
| Worker báo progress | buffer trong SDK, giới hạn kích thước, drop cái cũ nhất khi đầy |
| Worker báo complete/fail | **retry bền vững** — SDK ghi vào local durable buffer, gửi lại tới khi thành công |
| Tạo task mới từ backend | fail nhanh, hoặc ghi local outbox nếu app bật `localOutbox: true` |
| Frontend snapshot | unavailable; client giữ state cuối, `connection.status = "error"` |
| Cancel từ UI | unavailable; không được hứa cancel rồi không làm gì |
| Reconciliation | chạy sau khi phục hồi, sửa mọi trạng thái lệch |

### SDK worker phải chịu được RhinoQ down

```ts
rhinoq.attachWorker(worker, {
  onUnavailable: "continue",     // "continue" | "fail-job"
  progressBuffer: { maxItems: 100, dropOldest: true },
  terminalBuffer: { durable: true, path: "./.rhinoq-buffer" },
});
```

`onUnavailable: "continue"` là mặc định, và là điều làm cho lời hứa ở trên thành thật. `fail-job` chỉ dành cho task mà việc mất tracking là không chấp nhận được.

Terminal event (`complete`, `fail`) **phải** durable buffer, vì mất nó nghĩa là task treo `running` vĩnh viễn cho tới khi reconciler phát hiện.

### Sau khi phục hồi

```text
1. Worker SDK flush terminal buffer trước, progress buffer sau
2. Reconciler quét task running quá hạn heartbeat
3. Reconciler đối chiếu với runtime introspection
4. Task không xác định được → needs_attention + runtime_state_unknown
   (không tự kết luận failed)
```

### Công bố trong README

Bảng trên phải nằm trong README, cùng chỗ với bảng guarantee. Nó là lý do người ta dám cắm RhinoQ vào hệ thống đang chạy.

---

# 15. Kiến trúc đề xuất

```text
                    ┌──────────────────────────────────┐
                    │           Frontend SDK           │
                    │  useRhinoTask / Items / Stream   │
                    │  ┌────────────────────────────┐  │
                    │  │      Reducer (thuần)       │  │
                    │  ├────────────────────────────┤  │
                    │  │     ConnectionManager      │  │
                    │  │   1 kết nối / tab (8.11)   │  │
                    │  ├────────────────────────────┤  │
                    │  │  TaskTransport (interface) │  │
                    │  │  SSE · WS · Poll · custom  │  │
                    │  └────────────────────────────┘  │
                    └────────────────┬─────────────────┘
                                     │  REST + transport
                    ┌────────────────▼─────────────────┐
                    │         Delivery Gateway         │
                    │  auth/scope · snapshot · stream  │
                    │  coalescer (8.13) · shard (8.14) │
                    └────────────────┬─────────────────┘
                                     │  RealtimeBus (port)
                            ┌────────┴────────┐
                            │                 │
                     LISTEN/NOTIFY      Redis Pub/Sub
                            │                 │
                            └────────┬────────┘
                                     │
          ┌──────────────────────────▼──────────────────────────┐
          │                      Task Core                      │
          │  lifecycle · attempts · steps · items · streams     │
          │  results · ownership · reducer invariants           │
          └──────────┬────────────────────────────┬─────────────┘
                     │                            │
          ┌──────────▼──────────┐      ┌──────────▼───────────┐
          │   Execution Core    │      │    Provider Ops      │
          │  runtime adapter    │      │  poll/webhook/map    │
          │  liveness (14.6)    │      │  breaker/fallback    │
          └──────────┬──────────┘      └──────────┬───────────┘
                     │                            │
        ┌────────────┼────────────┬───────────────┘
        │            │            │
 Native Postgres  BullMQ    Custom HTTP
        │            │            │
        └────────────┴────────────┘
                     │
       PostgreSQL   durable truth (snapshot, history, ownership)
       Redis        optional hot path (fan-out, buffer, stream)
       Object store  large data (raw, export, archive)
```

Ba điểm khác so với sơ đồ bản v1:

1. **Delivery được tách thành lớp riêng** với coalescer và bus, không còn gộp chung vào "Task Gateway".
2. **Transport nằm sau interface**, cả ở client lẫn server.
3. **Reducer nằm ở client và là thành phần có tên**, vì nó là nơi tính đúng đắn được đảm bảo.

---

# 16. API đề xuất

## 16.1. Task

```http
POST   /v1/tasks
GET    /v1/tasks/{id}
GET    /v1/tasks
POST   /v1/tasks/{id}/cancel
POST   /v1/tasks/{id}/retry
GET    /v1/tasks/{id}/attempts
GET    /v1/tasks/{id}/events
GET    /v1/tasks/{id}/stream
GET    /v1/tasks/{id}/result
```

## 16.2. Progress/worker

```http
POST /v1/tasks/{id}/start
POST /v1/tasks/{id}/heartbeat
POST /v1/tasks/{id}/progress
POST /v1/tasks/{id}/complete
POST /v1/tasks/{id}/fail
POST /v1/tasks/{id}/cancelled
```

## 16.3. Items

```http
GET    /v1/tasks/{id}/items
GET    /v1/tasks/{id}/items/{key}
PUT    /v1/tasks/{id}/items/{key}
POST   /v1/tasks/{id}/items/{key}/progress
POST   /v1/tasks/{id}/items/{key}/complete
POST   /v1/tasks/{id}/items/{key}/fail
POST   /v1/tasks/{id}/items/{key}/retry
```

## 16.4. Provider

```http
POST /v1/provider-operations
GET  /v1/provider-operations/{id}
POST /v1/provider-operations/{id}/poll
POST /v1/provider-operations/{id}/cancel
POST /v1/providers/{provider}/webhook
```

## 16.5. Streams

```http
GET  /v1/tasks/{id}/streams
GET  /v1/tasks/{id}/streams/{name}?fromOffset=N
POST /v1/tasks/{id}/streams/{name}          (worker: append)
POST /v1/tasks/{id}/streams/{name}/close    (worker)
```

## 16.6. Delivery

```http
GET /v1/stream?subscribe=t1,t2,t3     SSE, multiplexed (mục 8.11)
WS  /v1/stream                        WebSocket, subscribe qua message
```

Endpoint `GET /v1/tasks/{id}/stream` ở mục 16.1 được giữ cho trường hợp một task đơn lẻ và cho share link, nhưng SDK mặc định dùng endpoint multiplexed.

## 16.7. Tokens

```http
POST /v1/tokens
```

Token scope — **đã đổi so với bản v1** để hỗ trợ multiplexing (mục 8.11):

```json
{
  "scope": {
    "tasks": ["task_1", "task_2"],
    "owner": "user_123",
    "tenant": "workspace_456"
  },
  "permissions": ["task:read", "task:cancel", "task:stream:read"],
  "expiresIn": "1h"
}
```

Ba kiểu scope:

| Kiểu | Dùng khi | Rủi ro |
|---|---|---|
| `tasks: [...]` | biết trước tập task | phải mint lại khi có task mới |
| `owner` | Task Center, danh sách động | token rộng hơn, TTL phải ngắn |
| `tasks` một phần tử | share link công khai | dùng kèm `permissions: ["task:read"]` |

Permission:

```text
task:read
task:cancel
task:retry
task:result
task:items:read
task:stream:read
task:raw:read        (mặc định không cấp cho frontend)
```

---

# 17. Event model

## 17.1. Envelope

```json
{
  "eventId": "evt_123",
  "taskId": "task_123",
  "taskAttempt": 2,
  "taskVersion": 18,
  "type": "task.progress",
  "occurredAt": "2026-07-29T...",
  "data": {}
}
```

## 17.2. Event types

```text
task.created
task.queued
task.started
task.progress
task.step.started
task.step.completed
task.retrying
task.cancellation_requested
task.cancelled
task.completion_requested
task.completed
task.partially_completed
task.failed
task.needs_attention
task.result.expired

task.item.discovered
task.item.started
task.item.progress
task.item.completed
task.item.failed
task.item.retrying

task.stalled
task.execution.orphaned

task.stream.opened
task.stream.chunk
task.stream.closed
task.stream.offset_expired

provider.requested
provider.accepted
provider.polling
provider.rate_limited
provider.webhook_received
provider.completed
provider.failed
provider.fallback_started
```

Lưu ý ngữ nghĩa: `task.stream.chunk` **không đi qua coalescer** và không mang `taskVersion` (mục 6.9). Nó có `streamName` + `offset` riêng.

## 17.3. Reducer rules

Reducer là trái tim của snapshot-first. Nó phải thuần túy, không phụ thuộc transport, và test được mà không cần network.

```ts
function reduce(current: TaskSnapshot, incoming: TaskDelta): TaskSnapshot {
  if (isTerminal(current.status) && !isTerminal(incoming.status)) return current;
  if (incoming.attempt > current.attempt) return applyFresh(incoming);
  if (incoming.attempt < current.attempt) return current;
  if (incoming.version <= current.version) return current;
  return apply(current, incoming);
}
```

Quy tắc:

- terminal state không bị state cũ ghi đè;
- attempt lớn hơn thắng, và reset progress;
- cùng attempt thì version lớn hơn thắng;
- version bằng hoặc nhỏ hơn thì bỏ, không merge;
- item version độc lập task version;
- event duplicate idempotent;
- event gap kích hoạt snapshot recovery, không kích hoạt replay vô hạn;
- snapshot luôn thắng delta cùng version — snapshot là nguồn, delta là tối ưu.

### Bất biến phải giữ

```text
1. Mọi transport chạy qua cùng một reducer.
2. Reducer không biết mình đang nhận từ SSE, WS hay polling.
3. Reload trang + fetch snapshot cho ra state giống hệt state đang có trên màn hình.
4. Hai client cùng theo dõi một task, sau khi cả hai ổn định, hội tụ về cùng một state.
```

Bất biến số 3 và số 4 là thứ phải có property test, không chỉ unit test.

---

# 18. Schema database đề xuất

## 18.1. `rhinoq_tasks`

```text
id
type
owner_id
tenant_id
status
attempt
version
progress_percent
current_step
summary_json
completion_policy_json
created_at
updated_at
completed_at
```

## 18.2. `rhinoq_task_attempts`

```text
task_id
attempt
status
error_json
started_at
finished_at
```

## 18.3. `rhinoq_executions`

```text
id
task_id
attempt
runtime
external_source
external_id
status
lease_owner
lease_epoch
started_at
finished_at
```

## 18.4. `rhinoq_task_steps`

```text
task_id
step_id
status
weight
current_value
total_value
progress_percent
version
```

## 18.5. `rhinoq_task_items`

```text
task_id
item_key
status
attempt
version
progress_percent
summary_json
result_ref_json
raw_result_ref_json
error_json
created_at
updated_at
```

Unique:

```text
(task_id, item_key)
```

## 18.6. `rhinoq_task_events`

```text
event_id
task_id
attempt
task_version
item_key
item_version
type
payload_json
occurred_at
```

## 18.7. `rhinoq_provider_operations`

```text
id
task_id
provider
operation_type
external_request_id
status
attempt
poll_count
next_poll_at
cost
raw_result_ref_json
last_error_json
```

## 18.8. `rhinoq_task_tokens`

```text
token_hash
subject
scope_tasks_json      -- danh sách task id, null nếu scope theo owner
scope_owner_id        -- null nếu scope theo tasks
scope_tenant_id
permissions
expires_at
revoked_at
created_at
```

Đổi so với bản v1: bỏ cột `task_id` đơn lẻ, thay bằng scope linh hoạt để hỗ trợ multiplexing (mục 8.11).

## 18.9. `rhinoq_task_streams`

```text
task_id
attempt
name
status                -- open | closed | failed
chunk_count
last_offset
buffer_backend        -- redis | memory
opened_at
closed_at
```

Chunk **không** lưu trong PostgreSQL mặc định. Chúng nằm trong Redis Stream hoặc buffer bộ nhớ, có TTL. Bảng này chỉ giữ metadata và điểm neo cho archive.

Unique:

```text
(task_id, attempt, name)
```

## 18.10. Chỉ mục cần có

```sql
-- truy vấn history theo user, thường xuyên nhất
CREATE INDEX ON rhinoq_tasks (owner_id, created_at DESC);
CREATE INDEX ON rhinoq_tasks (tenant_id, status, created_at DESC);

-- reconciler quét task treo (mục 14.6)
CREATE INDEX ON rhinoq_executions (status, last_heartbeat_at)
  WHERE status IN ('running', 'claimed');

-- item list có phân trang theo cursor
CREATE INDEX ON rhinoq_task_items (task_id, created_at, item_key);

-- dọn event cũ
CREATE INDEX ON rhinoq_task_events (occurred_at);
```

## 18.9b. `rhinoq_task_definitions`

```text
name
version
input_schema_json
result_schema_json
summary_schema_json
execution_json
capabilities_json
progress_json
retention_json
data_policy_json
created_at
deprecated_at
```

Unique:

```text
(name, version)
```

## 18.9c. `rhinoq_dispatch_outbox`

```text
id
task_id
execution_id
runtime
idempotency_key        UNIQUE
payload_json
status                 pending | sent | failed | abandoned
attempt
next_retry_at
last_error_json
created_at
sent_at
```

Chỉ mục cho dispatcher:

```sql
CREATE INDEX ON rhinoq_dispatch_outbox (status, next_retry_at)
  WHERE status IN ('pending', 'failed');
```

## 18.9d. Cột bổ sung cho `rhinoq_tasks`

Theo mô hình bốn chiều ở mục 7.1:

```text
definition_name
definition_version
lifecycle              queued | running | terminal
substate               pending_dispatch | queued | running | retrying | cancellation_requested
outcome                succeeded | partial | failed | cancelled | NULL
health                 healthy | stalled | needs_attention
health_reason
result_state           none | available | expired | deleted | missing
status                 -- GENERATED, projection chỉ đọc (7.1)
parent_task_id
root_task_id
relationship
durable_version
progress_json          -- theo Progress ba chế độ (7.11)
```

`status` nên là generated column hoặc view, **không phải cột ghi tay** — nếu ghi tay được thì sớm muộn sẽ có code ghi thẳng vào nó và mô hình bốn chiều mất tác dụng.

## 18.9e. Bất biến ở tầng database

```sql
-- một external execution không thuộc hai task
CREATE UNIQUE INDEX ON rhinoq_executions (runtime, external_id)
  WHERE external_id IS NOT NULL;

-- mỗi commandId chỉ tạo một hiệu ứng
CREATE UNIQUE INDEX ON rhinoq_commands (command_id);

-- outcome chỉ có nghĩa khi terminal
ALTER TABLE rhinoq_tasks ADD CONSTRAINT outcome_only_when_terminal
  CHECK ((lifecycle = 'terminal') = (outcome IS NOT NULL));
```

Đưa bất biến xuống database là cách rẻ nhất để chúng không bị vi phạm khi code đổi.

## 18.11. Retention

Bắt buộc có từ V1, không để sau:

```text
rhinoq_task_events      giữ 7 ngày mặc định
rhinoq_task_items       theo retention của task
rhinoq_tasks            giữ 90 ngày mặc định, cấu hình theo type
stream buffer           TTL 1 giờ
```

Task đã terminal có thể nén: xóa event chi tiết, giữ snapshot cuối và attempt summary. Đây là điều kiện để "task history sống lâu hơn queue retention" không biến thành bảng phình vô hạn.

---

# 19. SDK đề xuất

## 19.1. Packages

```text
@rhinoq/client
@rhinoq/node
@rhinoq/nestjs
@rhinoq/react
@rhinoq/bullmq
```

Sau này:

```text
rhinoq-python
rhinoq-celery
rhinoq-go
@rhinoq/vue
```

## 19.2. Node API

```ts
const task = await rhinoq.tasks.create({
  type: "scan-channel",
  ownerId,
  tenantId,
  input,
});

await task.enqueue();
```

Worker:

```ts
rhinoq.worker("scan-channel", async (ctx, input) => {
  await ctx.step("scan", async () => {
    // business logic
  });

  await ctx.complete({ resultRef });
});
```

## 19.3. BullMQ

```ts
const adapter = RhinoQBullMQ.attach({
  queue,
  worker,
  taskId: job => job.data.taskId,
});
```

## 19.4. React

```tsx
const {
  task,
  connection,
  cancel,
  retry,
} = useRhinoTask({ taskId, token, transport: "auto" });
```

Items:

```tsx
const {
  items,
  loadMore,
  retryItem,
} = useRhinoTaskItems({ taskId, token });
```

Streams:

```tsx
const { chunks, isStreaming, offset } = useRhinoTaskStream(
  taskId,
  "answer",
  { token },
);
```

Danh sách task của một user (Task Center):

```tsx
const { tasks, loadMore } = useRhinoTasks({
  token,              // token scope theo owner
  filter: { status: ["running", "queued"] },
});
```

### Provider và connection manager

```tsx
<RhinoProvider
  baseUrl="/rhinoq"
  token={token}
  transport="auto"
  maxSubscriptionsPerConnection={200}
>
  <App />
</RhinoProvider>
```

`RhinoProvider` sở hữu `ConnectionManager` (mục 8.11). Mọi hook bên dưới chia sẻ một kết nối. **Dùng hook ngoài provider sẽ mở kết nối riêng và log cảnh báo** — đây là lỗi cấu hình phổ biến nhất cần bắt sớm.

## 19.5. Components

```tsx
<RhinoTaskProgress />
<RhinoTaskList />
<RhinoTaskItems />
<RhinoTaskCenter />
```

Components là optional; hook là nền tảng.

## 19.6. Ba giao diện, không phải một

> Bản v2.0 nhắc tới Task Center và Task Inspector rời rạc, có nguy cơ trộn thành một màn hình. Ba đối tượng người dùng này có dữ liệu, quyền và ngôn ngữ hoàn toàn khác nhau.

### End-user Task Center

Cho người dùng cuối trong sản phẩm của khách hàng.

```text
task của tôi · tiến độ · kết quả · cancel/retry
thông báo thân thiện, không có mã lỗi kỹ thuật
```

Dữ liệu: snapshot rút gọn, `SafeMessage`, `resultRef` đã resolve.
Quyền: scoped token của chính user.
Hình thức: React components trong `@rhinoq/react`, khách hàng nhúng vào app của họ.

### Operator Console

Cho support và vận hành của khách hàng.

```text
task stalled · provider failure · execution history
retry/force-resolve · lọc theo tenant · audit
```

Dữ liệu: mọi task trong tenant, `healthReason`, lịch sử attempt.
Quyền: operator credential, có audit log.
Hình thức: ứng dụng web riêng đi kèm RhinoQ.

### Developer Inspector

Cho developer khi debug.

```text
raw event timeline · version/attempt · runtime mapping
heartbeat · payload reference · trace link · reducer decisions
outbox state · capability của runtime
```

Dữ liệu: mọi thứ, kể cả `InternalMessage`.
Quyền: `task:raw:read`, mặc định chỉ bật ở môi trường non-production.

### Thứ tự làm

Một người không ship được ba giao diện. Thứ tự:

```text
V1:  Developer Inspector      (bạn cần nó để tự debug, làm trước là đúng)
V2:  Operator Console         (khi có người dùng thật gặp sự cố)
V2:  End-user components      (ở dạng component library, không phải app)
```

Ba giao diện dùng chung một codebase với view được phân quyền, **nhưng dữ liệu trả về phải khác nhau ở tầng API**, không phải ẩn hiện ở tầng UI. Ẩn ở UI là lỗ hổng.

---

# 20. Security, ownership và data governance

## 20.1. Bốn mặt phẳng xác thực

> Bản v2.0 gộp mọi caller vào một mô hình token. Thực tế RhinoQ có ít nhất bốn loại caller với nhu cầu và rủi ro hoàn toàn khác nhau. Dùng chung credential là lỗi thiết kế bảo mật, không phải tiện lợi.

```text
1. End-user frontend      → xem/cancel/retry task được phép
2. Application backend    → tạo task, phát scoped token cho frontend
3. Worker / runtime       → start, progress, complete, fail, heartbeat
4. Operator / admin       → inspect, force-resolve, đọc raw error
```

| Mặt phẳng | Credential | Vòng đời | Không được phép |
|---|---|---|---|
| End-user | scoped token, JWT ngắn hạn | phút–giờ | tạo task, đọc raw, đổi ownership |
| Application | API key hoặc mTLS | dài, xoay vòng được | đọc raw của tenant khác |
| Worker | worker token gắn với execution | bằng vòng đời execution | đọc task khác, tạo task |
| Operator | tài khoản người thật + MFA | phiên đăng nhập | ghi trực tiếp vào DB |

**Worker token gắn với execution** là điểm quan trọng: worker chỉ báo cáo được cho đúng execution nó đang giữ lease, không phải cho task bất kỳ.

## 20.2. Không tin ownerId và tenantId từ browser

Ví dụ ở mục 8.1 nhận `ownerId` và `tenantId` trong body request. **Nếu request đó đến từ browser, đây là lỗ hổng leo thang quyền.**

```json
// KHÔNG BAO GIỜ tin nếu caller là frontend
{ "ownerId": "user_123", "tenantId": "workspace_456" }
```

Quy tắc:

- `POST /v1/tasks` chỉ chấp nhận **application credential**, không chấp nhận scoped token của end-user.
- Application backend **derive** `ownerId`/`tenantId` từ authentication context của chính nó, không lấy từ payload client gửi lên.
- Nếu bắt buộc phải cho frontend tạo task trực tiếp, dùng token một lần scope theo `definitionName` + `ownerId` đã cố định trong token, và server bỏ qua mọi giá trị owner/tenant trong body.

## 20.3. Cấu trúc token

```json
{
  "iss": "rhinoq",
  "aud": "rhinoq-api",
  "sub": "user_123",
  "jti": "tok_9f2a",
  "exp": 1753900000,
  "iat": 1753896400,
  "pv": 3,
  "scope": { "owner": "user_123", "tenant": "ws_456" },
  "permissions": ["task:read", "task:cancel", "task:stream:read"],
  "limits": { "maxSubscriptions": 200 }
}
```

- `jti` cho phép revoke từng token.
- `pv` là **permission version**: đổi quyền của user thì tăng `pv`, mọi token có `pv` cũ bị từ chối ngay, không cần đợi hết hạn.
- `limits` chặn một client mở subscription vô hạn.
- **Rotation:** SDK tự lấy token mới trước khi hết hạn; đổi token không được làm mất subscription (đây là một mục kiểm thử ở 27.3).

## 20.4. Chống enumeration

Task ID phải là định danh không đoán được — ULID hoặc UUIDv7 với phần random đủ dài, không dùng số tăng dần.

- Task không thuộc scope → trả **404**, không phải 403. Trả 403 xác nhận task tồn tại.
- Rate limit trên endpoint snapshot theo `sub`, không chỉ theo IP.
- Không đưa `ownerId` của người khác vào bất kỳ response nào.

## 20.5. Mô hình quyền

```text
Vai trò:  owner · tenant-member · viewer · operator · admin

Permission:
  task:read
  task:cancel
  task:retry
  task:result
  task:items:read
  task:items:retry
  task:stream:read
  task:raw:read          ← không bao giờ cấp mặc định cho frontend
  task:force-resolve     ← chỉ operator
```

App tích hợp qua một trong hai mode:

- **Signed claims** — ứng dụng phát JWT có claims chuẩn, RhinoQ verify bằng khóa công khai.
- **Auth callback** — RhinoQ gọi hàm authorization do ứng dụng cung cấp (mặc định trong library mode).

## 20.6. Data governance

> Thiếu hoàn toàn trong bản v2.0. RhinoQ lưu input, summary, raw provider result, event, stream và error. Những chỗ này rất dễ chứa API token, email, nội dung file, prompt, response provider, signed URL và secret nghiệp vụ.
>
> Một hệ thống hạ tầng làm rò rỉ dữ liệu qua bảng event là lỗi không thể chấp nhận, và nó xảy ra rất dễ vì không ai cố ý.

### Policy theo TaskDefinition

```ts
dataPolicy: {
  storeInput: "encrypted",          // "plain" | "encrypted" | "redacted" | "none"
  redactPaths: [
    "$.authorization",
    "$.apiKey",
    "$.customer.email",
  ],
  eventPayload: "summary-only",     // "full" | "summary-only" | "reference-only"
  rawResultRetentionDays: 7,
  allowAdminRawAccess: false,
}
```

### Yêu cầu bắt buộc

- **Secret không bao giờ được ghi vào event.** Event là nơi dữ liệu sống lâu nhất và được đọc nhiều nhất.
- **Redaction chạy ở biên ghi**, không phải ở biên đọc. Đã ghi rồi thì coi như đã rò.
- **Encryption at rest** cho `input_json` và `summary_json` khi `storeInput: "encrypted"`; khóa do ứng dụng cung cấp, RhinoQ không giữ.
- **Signed URL không persist.** Xem 7.6 — chỉ lưu provider + key.
- **Log redaction** dùng chung `redactPaths`.
- **Audit khi admin đọc raw result** — ai, lúc nào, task nào. `allowAdminRawAccess: false` là mặc định.
- **Delete cascade** theo user và tenant, cho GDPR/xóa tài khoản:

```http
DELETE /v1/tenants/{id}/data
DELETE /v1/owners/{id}/data
GET    /v1/owners/{id}/export
```

Cascade phải chạm tới: tasks, attempts, executions, items, events, streams, provider operations, outbox, và object storage theo `ResultRef`.

### Về việc lưu reasoning của model

Ví dụ `ctx.stream("reasoning")` ở mục 9.6 **không nên được khuyến khích như chuẩn chung**, và tài liệu này rút lại nó.

Lý do: nội dung suy luận nội bộ của model thường chứa thông tin không dành cho người dùng cuối, dễ gây hiểu nhầm khi hiển thị, và lưu lại làm tăng bề mặt rò rỉ mà không mang lại giá trị tương xứng.

Tên stream khuyến nghị:

```text
answer         nội dung trả về cho người dùng
status         thông báo tiến trình dạng văn bản
tool-events    sự kiện gọi công cụ, đã lọc
debug-trace    chỉ bật khi cần, retention ngắn, cần task:raw:read
```

## 20.7. Result security

- cấp URL tại thời điểm đọc qua `ResultResolver`, TTL ngắn;
- kiểm tra permission mỗi lần resolve, không chỉ lúc tạo task;
- raw result là scope riêng, mặc định không cấp;
- audit download khi `allowAdminRawAccess: true`;
- checksum verify trước khi trả cho người dùng nếu `Immutable: true`.

---

# 21. Tái sử dụng repository hiện tại

Repository hiện có cấu trúc:

```text
internal/
├── adapters
├── application
├── contracts
├── domain
├── infrastructure
├── interfaces
├── ports
└── runtime

sdks/
├── node
└── typescript
```

Domain hiện đã có:

```text
admission
attempt
change
correlation
effect
finding
job
outcome
recovery
retry
rule
subjectoutcome
```

Application có:

```text
attention
effect
enqueue
execution
findings
operations
rules
verification
```

## 21.1. Giữ gần như nguyên

- job runtime;
- attempt;
- retry;
- admission;
- cancellation;
- correlation;
- fenced lease;
- scheduler;
- graceful shutdown;
- PostgreSQL store foundation;
- HTTP Agent/Gateway foundation;
- Node SDK foundation;
- audit;
- Effect Ledger;
- Workbench shell.

## 21.2. Refactor để dùng lại

### Job → Execution

Không đổi tên tất cả ngay. Thêm `Task` phía trên `Job`.

```text
Task 1:N Execution
Execution có thể tham chiếu Job hiện tại
```

### Correlation

Mở rộng correlation thành Task–Execution–Provider–Subject linkage.

### Outcome

Dùng cho verified completion.

### Finding

Dùng cho `needs_attention`.

### Workbench

Mở rộng thành Task Inspector/Operator Console.

### Agent protocol

Thêm capabilities:

```text
task
progress
subscribe
event-replay
result
task-token
provider-operation
```

## 21.3. Xây mới

```text
internal/domain/task
internal/domain/taskitem
internal/domain/provideroperation
internal/domain/result
internal/application/tasks
internal/application/taskitems
internal/application/providers
internal/application/delivery
internal/ports/task_store.go
internal/ports/task_event_store.go
internal/ports/provider_store.go
internal/ports/result_store.go
internal/interfaces/taskapi
internal/interfaces/sse
```

## 21.4. Hạ ưu tiên, không xóa

- Rule-first onboarding;
- integrity-only homepage;
- business repair workflow;
- SQL rule editor;
- Finding-first navigation.

Chuyển thành `Verified Tasks` và advanced operations.

## 21.5. Không nên làm ngay

- MySQL native runtime;
- Redis native queue riêng;
- visual workflow builder;
- hàng trăm provider connectors;
- AI root cause;
- mobile SDK;
- multi-region active-active;
- enterprise SSO.

---

# 22. Cấu trúc repository đề xuất

```text
internal/
├── domain/
│   ├── task/
│   ├── taskitem/
│   ├── execution/
│   ├── provideroperation/
│   ├── result/
│   ├── attempt/
│   ├── retry/
│   ├── effect/
│   ├── finding/
│   └── rule/
│
├── application/
│   ├── tasks/
│   ├── taskitems/
│   ├── executions/
│   ├── providers/
│   ├── delivery/
│   ├── verification/
│   └── operations/
│
├── ports/
│   ├── task_store.go
│   ├── task_event_store.go
│   ├── execution_runtime.go
│   ├── provider_store.go
│   ├── result_store.go
│   ├── realtime_bus.go
│   └── authorization.go
│
├── adapters/
│   ├── postgres/
│   ├── redis/
│   ├── bullmq/
│   ├── objectstorage/
│   └── providers/
│
├── interfaces/
│   ├── taskapi/
│   ├── workerapi/
│   ├── sse/
│   ├── webhook/
│   └── workbench/
│
└── runtime/
    ├── lease/
    ├── scheduler/
    ├── worker/
    ├── supervisor/
    └── shutdown/
```

---

# 23. MVP bắt buộc

## 23.1. Mục tiêu

Chứng minh:

> Một developer có thể thêm user-facing long-running task mà không tự viết status API, SSE, polling fallback, cancel, retry và result flow.

## 23.2. Phạm vi

### Backend

- Task model;
- Native PostgreSQL runtime;
- Node SDK;
- task snapshot API;
- progress;
- retry;
- cancel;
- JSON result;
- history.

### Delivery

- `TaskTransport` interface với hai implementation: SSE và polling;
- **connection multiplexing** (mục 8.11) — không được để sau, vì nó đổi thiết kế token;
- `RealtimeBus` port với adapter `notify`;
- coalescer ở gateway;
- version + Last-Event-ID + reconnect;
- reducer thuần với property test cho bốn bất biến ở mục 17.3;
- terminal stop.

### Stream

- một stream channel per task;
- worker `ctx.stream(name).write()` / `.close()`;
- `useRhinoTaskStream`;
- buffer trong bộ nhớ gateway ở V1 (Redis ở Phase 3), công bố rõ giới hạn không phục hồi sau restart.

### Frontend

- `@rhinoq/client`;
- `@rhinoq/react`;
- `RhinoProvider` + `ConnectionManager`;
- `useRhinoTask`, `useRhinoTaskStream`;
- progress component cơ bản.

### Nền tảng đúng đắn — không được cắt

Năm thứ dưới đây rẻ khi làm từ đầu và rất đắt khi thêm sau:

- **TaskDefinition** với `capabilities` (schema để tùy chọn) — mục 7.10;
- **mô hình state bốn chiều** + `status` derived — mục 7.1;
- **command envelope** với `commandId` + `expectedAttempt`, và bảng ưu tiên — mục 8.18;
- **dispatch outbox** + reconciler — mục 14.7;
- **event envelope có `schemaVersion`** và các ID xuyên suốt — mục 40.2.

Bốn trong năm thứ này thay đổi hình dạng dữ liệu. Thêm sau nghĩa là migration trên dữ liệu production.

### Deployment

- **library mode** (`@rhinoq/nestjs`) — là mode được test đầu tiên, không phải mode phụ;
- service mode tối giản.

### Redis

- optional;
- realtime pub/sub;
- progress buffer;
- stream buffer bền;
- không bắt buộc V1 single-node.

## 23.3. Không làm trong MVP đầu

- Task Items lớn;
- Provider Operation đầy đủ;
- mapping workbench;
- object storage connector phức tạp;
- multi-execution task;
- sharding;
- WebSocket transport;
- Python SDK.

> Đổi so với bản v1: **BullMQ adapter không còn nằm trong danh sách này.** Nó là khác biệt cạnh tranh lớn nhất, phải xuất hiện sớm — xem Phase 2 ở mục 26.

## 23.4. Demo

Video scraper:

```text
Create scan task
→ queued
→ running
→ progress 20/100
→ reload frontend
→ state vẫn đúng
→ ngắt SSE
→ polling degrade (với transport: "auto")
→ SSE phục hồi
→ đặt transport: "sse" và ngắt lại → connection.status = "error", state giữ nguyên
→ mở 10 task cùng lúc → vẫn 1 kết nối
→ cancel/retry
→ completed
→ result displayed
```

Demo phụ, ngắn hơn nhưng quan trọng cho AI audience:

```text
Create generate task
→ token chảy ra qua useRhinoTaskStream
→ reload giữa chừng
→ replay từ offset
→ completed
→ full text lấy từ resultRef, không phụ thuộc chunk đã nhận
```

---

# 24. MVP mở rộng thứ hai

Sau khi lifecycle cơ bản ổn:

- Task Items;
- cursor pagination;
- incremental result;
- item retry;
- result references;
- payload guard;
- event batching;
- BullMQ adapter.

Demo:

```text
Scan 10 videos
→ item xuất hiện dần
→ 3 download song song
→ link hiện khi từng video xong
→ item lỗi retry riêng
```

---

# 25. Provider MVP

Chỉ generic provider primitive:

```text
start
poll
webhook
timeout
retry
cancel
normalize
```

Không làm provider marketplace.

Demo provider:

- generic fake async API;
- hoặc provider ổn định có request ID + poll.

TikTok provider có thể dùng làm example riêng, không nên là official core connector đầu tiên vì API bên thứ ba dễ đổi.

---

# 26. Roadmap đề xuất

## Phase 0 — Tái định vị

- viết lại README;
- thêm ADR;
- tạo product spec;
- xác định Task invariants;
- không xóa code cũ;
- đóng băng feature integrity mới trừ bug.

## Phase 1 — Task Core

- TaskDefinition + registry (7.10);
- Task với mô hình bốn chiều (7.1);
- TaskAttempt;
- Execution link + unique external reference;
- command envelope + bảng ưu tiên (8.18);
- TaskError model (7.6b);
- Progress ba chế độ (7.11);
- Postgres migrations + bất biến ở tầng DB (18.9e);
- APIs;
- model-based test cho state machine.

## Phase 2 — Delivery + BullMQ

> **Đổi thứ tự so với bản v1.** BullMQ adapter từ Phase 5 lên đây. Lý do: "giữ nguyên queue của bạn" là khác biệt cạnh tranh số một. Nếu nó xuất hiện ở giữa roadmap thì sáu tháng đầu RhinoQ không có gì để nói mà Trigger.dev chưa nói tốt hơn.

Delivery:

- snapshot + event log;
- `TaskTransport` interface;
- SSE transport + polling transport;
- connection multiplexing;
- `RealtimeBus` adapter `notify`;
- coalescer;
- replay + snapshot recovery;
- JS client reducer + property test;
- React hook + `RhinoProvider`.

BullMQ:

- adapter `attachWorker`;
- progress/completion/cancellation mapping;
- adapter heartbeat (mục 14.6);
- runtime introspection reconciler;
- **bảng công bố guarantee** trong README.

## Phase 3 — Product actions + Stream

- cancel;
- retry;
- history;
- result;
- ownership/token với scope mới;
- stream channel + Redis buffer;
- `useRhinoTaskStream`.

## Phase 4 — Task Items

- item model;
- pagination;
- incremental updates;
- item retry;
- payload guards.

## Phase 5 — Scale delivery

- Redis `RealtimeBus`;
- WebSocket transport;
- sharding;
- backpressure hoàn chỉnh;
- benchmark theo mục 28.

## Phase 6 — Provider Operations

- generic adapter;
- polling;
- webhook;
- rate limit;
- timeout;
- idempotency;
- raw result refs;
- normalization.

## Phase 7 — Verified Tasks

- output verifier;
- Effect Ledger integration;
- needs_attention;
- guarded replay;
- Workbench task view.

## Phase 8 — Ecosystem

- Python;
- Celery;
- Vue;
- Redis scaled realtime;
- provider connectors.

---

# 27. Tiêu chí kiểm thử

## 27.1. Lifecycle

- valid transitions;
- invalid transitions rejected;
- duplicate commands idempotent;
- terminal state immutable.

## 27.2. Concurrency

- worker cũ không update progress;
- stale attempt ignored;
- concurrent progress increments;
- cancel vs complete race;
- retry vs late completion race.

## 27.3. Delivery

Nhóm cơ bản:

- event ordering;
- duplicate event;
- lost event;
- reconnect;
- Last-Event-ID;
- degrade sang polling khi `transport: "auto"`;
- **không** degrade khi `transport: "sse"`, và `connection.status` chuyển `error`;
- switch back to SSE;
- multi-tab;
- terminal stop.

Nhóm multiplexing:

- 50 hook cùng lúc → đúng một kết nối;
- unsubscribe task cuối → kết nối đóng sau debounce;
- subscribe task mới trên kết nối đang mở, không mở lại;
- vượt `maxSubscriptionsPerConnection` → mở kết nối thứ hai;
- token hết hạn giữa chừng → refresh không mất subscription.

Nhóm coalescing:

- 10.000 progress event → số message tới client dưới ngưỡng;
- terminal state không bị coalesce;
- step transition không bị coalesce;
- stream chunk không bị coalesce.

Nhóm fan-out:

- worker báo qua node A, client cắm node B;
- payload vượt 8000 byte với bus `notify` → vẫn đúng (đi qua đường đọc snapshot);
- gateway restart giữa chừng → client hội tụ lại;
- reconnect storm 500 client → không sập.

Nhóm bất biến (property test, mục 17.3):

- reload + snapshot cho ra state giống state trên màn hình;
- hai client hội tụ về cùng state;
- thứ tự event ngẫu nhiên → kết quả cuối không đổi;
- terminal state không bao giờ bị đảo ngược.

## 27.7. Stream

- replay từ offset;
- offset đã hết hạn → trả `stream_offset_expired`, không im lặng;
- task terminal → stream tự đóng;
- retry → stream attempt cũ không phát nữa;
- mất chunk giữa chừng → client biết mình mất, không giả vờ đủ;
- `resultRef` đúng kể cả khi client chưa nhận đủ chunk.

## 27.8. External runtime liveness

- worker BullMQ bị kill → `stalled` trong `stalledAfterMs`;
- job biến mất khỏi Redis → `unknown`, không tự kết luận `failed`;
- worker chậm nhưng còn sống → không bị đánh dấu sai;
- `maxDurationMs` quá hạn → `needs_attention`, không `failed`;
- worker hồi sinh sau khi bị đánh `stalled` → xử lý được, không tạo trạng thái mâu thuẫn.

## 27.4. Items

- duplicate item key;
- item event ordering;
- pagination while items are added;
- item retry;
- partial completion;
- large result reference.

## 27.5. Provider

- provider timeout;
- rate limited;
- duplicate webhook;
- webhook before polling;
- polling before webhook;
- fallback;
- idempotency;
- cost limit.

## 27.6. Security

- user A không đọc được task của user B;
- task không thuộc scope trả 404, không phải 403;
- token hết hạn;
- `pv` cũ bị từ chối ngay sau khi đổi quyền;
- cancel không có scope;
- truy cập raw result;
- tenant isolation;
- `ownerId` giả trong body bị bỏ qua khi caller là frontend;
- secret trong input không xuất hiện trong bảng event;
- delete cascade xóa hết trong mọi bảng và object storage.

## 27.9. Cấp độ kiểm thử nâng cao

Property test cho reducer là điều kiện cần, không phải đủ. Một platform nhiều runtime và nhiều SDK cần thêm:

| Loại test | Bắt được gì |
|---|---|
| **Model-based test** cho state machine bốn chiều | transition không hợp lệ mà bảng ưu tiên bỏ sót |
| **Adapter conformance suite** | adapter cộng đồng khai capability sai so với hành vi thật |
| **Chaos test** — kill worker / gateway / Redis / PostgreSQL giữa chừng | mất terminal state, task treo, orphan |
| **Duplicate và out-of-order event** | reducer không idempotent |
| **Version-skew test** server mới ↔ SDK cũ và ngược lại | breaking change lọt qua |
| **Migration test** với dữ liệu phiên bản trước | migration làm hỏng task cũ |
| **Reconnect storm** 1.000 client | thundering herd, gateway sập |
| **Noisy-neighbor** một tenant tạo 10.000 task | tenant khác bị đói tài nguyên |
| **Fuzz test** event envelope | crash khi nhận payload dị dạng |

### Chín bất biến phải có test riêng

```text
1. Terminal không bao giờ quay lại non-terminal
2. Attempt cũ không sửa được attempt mới
3. Một external execution không thuộc hai task
4. Mỗi commandId chỉ tạo đúng một hiệu ứng nghiệp vụ
5. version đơn điệu tăng trên toàn hệ thống cho một task
6. snapshot.version >= mọi version đã phát qua transport
7. durableVersion <= version
8. State có ý nghĩa luôn có durableVersion == version
9. Task không bao giờ ở pending_dispatch quá dispatchTimeoutMs mà không được xử lý
```

Bất biến 3, 4 và 9 là ba thứ chỉ xuất hiện sau khi có outbox và adapter — dễ bị quên nhất.

---

# 28. Benchmark và SLO

Không quảng cáo throughput trước benchmark.

Cần benchmark:

- task creation;
- claim batch;
- progress update;
- SSE fan-out;
- reconnect storm;
- item upsert;
- event insert;
- Redis buffer;
- Postgres coalescing;
- retention cleanup.

Bổ sung cần benchmark (không có trong bản v1):

- số subscription tối đa trên một gateway node;
- chi phí `LISTEN/NOTIFY` khi số node tăng;
- tỉ lệ nén của coalescer (event vào / message ra);
- stream throughput chunk/giây;
- reconnect storm 1.000 client.

Đề xuất SLO ban đầu:

```text
Task snapshot p95:             < 200 ms
Realtime delivery p95:         < 1 s
Degrade activation:            < 5 s
Terminal convergence:          < 2 s
Coalescer compression:         > 20:1 với progress dày
Stream chunk p95:              < 300 ms
No lost terminal state:        required
Inline payload limit:          enforced
```

Các số này cần được kiểm chứng rồi mới công bố.

## 28.1. Observability

> Thiếu hoàn toàn trong bản v1. Ba đối thủ đều mạnh về mảng này; không có là điểm trừ rõ ràng trong đánh giá kỹ thuật.

### OpenTelemetry

Bắt buộc từ Phase 3:

- trace context truyền từ API tạo task → execution → provider operation → completion;
- span per attempt, per step, per provider call;
- `taskId`, `attempt`, `taskType`, `tenantId` là span attribute chuẩn;
- exporter cấu hình được, không hardcode backend.

### Metrics

```text
rhinoq_tasks_created_total{type}
rhinoq_tasks_terminal_total{type,status}
rhinoq_task_duration_seconds{type}
rhinoq_executions_stalled_total{runtime}
rhinoq_delivery_connections_active
rhinoq_delivery_subscriptions_active
rhinoq_delivery_events_in_total / _out_total     -- tỉ lệ = nén của coalescer
rhinoq_delivery_degraded_total{from,to}
rhinoq_stream_chunks_total{name}
rhinoq_provider_operations_total{provider,status}
```

### ID xuyên suốt

RhinoQ phải nối được toàn bộ hành trình, nếu không thì "dễ theo dõi" chỉ là khẩu hiệu:

```text
HTTP request → Task → Attempt → Execution → BullMQ job → ProviderOperation → Result
```

Các ID bắt buộc có mặt trong mọi log, event và span:

```text
traceId          W3C trace context, từ request gốc
correlationId    do ứng dụng cấp, xuyên suốt một luồng nghiệp vụ
causationId      ID của thứ trực tiếp gây ra sự kiện này
taskId
attempt
executionId
externalId       job ID của runtime ngoài
```

`causationId` là thứ hay bị bỏ qua nhưng quan trọng nhất khi debug: nó cho biết event này sinh ra từ command nào, hay từ event nào khác.

### Ba metric quyết định lời hứa

Nếu không đo được ba chỉ số này, RhinoQ không chứng minh được nó "đáng tin hơn code tự viết":

```text
snapshot_freshness_seconds        chênh lệch giữa version hot và durable (8.17)
terminal_convergence_seconds      từ lúc worker báo terminal tới lúc client hội tụ
orphaned_executions_total         số execution không map được về task (14.7)
```

Ba chỉ số này phải xuất hiện trên dashboard mặc định và trong benchmark công bố.

### Metric đầy đủ

```text
task_queue_duration_seconds{type}
task_run_duration_seconds{type}
task_end_to_end_duration_seconds{type}
task_success_rate{type}
task_stalled_total{runtime}
task_retry_total{type,reason}
task_dispatch_failed_total{runtime}

snapshot_age_seconds
delivery_lag_seconds
coalescing_ratio
active_subscriptions
active_connections
reconnect_rate
stream_replay_failures_total
runtime_reconciliation_drift

provider_operations_total{provider,status}
provider_late_completion_total{provider}
```

### Task Inspector

Giữ nguyên mục tiêu ở mục 2.4 nhưng bổ sung: mỗi task có deep link tới trace tương ứng. QA thấy triệu chứng, dev nhảy thẳng vào trace.

---

# 29. Product validation

## 29.1. Activation

Developer mới phải:

```text
install
→ migrate
→ create task
→ worker progress
→ React display
```

trong một buổi, không viết controller realtime.

## 29.2. Retention signal

Người dùng áp dụng RhinoQ cho task thứ hai.

## 29.3. Những câu hỏi phỏng vấn

- Bạn đang có bao nhiêu long-running operations?
- Mỗi task hiện phải viết những endpoint nào?
- Frontend đang polling hay realtime?
- Có cancel/retry/history không?
- Có external provider phải poll không?
- Có partial results không?
- Từng gặp progress sai sau retry/reconnect chưa?
- Có sẵn internal task framework chưa?

## 29.4. Dấu hiệu nên tiếp tục

- developer tích hợp vào dự án thật;
- dùng cho task thứ hai;
- xóa được code cũ;
- QA dùng Task Inspector;
- có yêu cầu BullMQ adapter;
- có yêu cầu provider polling.

## 29.5. Dấu hiệu nên thu hẹp

- chỉ dùng như progress bar demo;
- user vẫn tự viết status endpoint;
- integration phức tạp hơn tự code;
- không ai dùng cancel/history/result;
- người dùng yêu cầu migrate runtime quá nhiều.

---

# 30. Rủi ro

## 30.1. Scope explosion

Nguy cơ lớn nhất.

Mitigation:

- một vertical slice;
- Task Core trước;
- Provider sau;
- không workflow builder.

## 30.2. Abstraction không giảm code

Mitigation:

- đo số file/endpoint người dùng xóa;
- zero-boilerplate quickstart;
- task thứ hai phải cực nhanh.

## 30.3. Dữ liệu lớn gây sập

Mitigation:

- ResultRef;
- payload limits;
- pagination;
- batching;
- throttling;
- object storage;
- backpressure.

## 30.4. Native runtime chưa đủ mature

Mitigation:

- BullMQ adapter;
- controlled deployment;
- benchmark;
- explicit guarantees.

## 30.5. Trigger.dev/Inngest mở adapter cho runtime ngoài

**Đây là rủi ro nghiêm trọng nhất, không phải scope explosion.** Nếu Trigger.dev ra `attachExistingWorker`, khác biệt chiến lược số một của RhinoQ biến mất trong một đêm.

Đánh giá xác suất: thấp trong 12–18 tháng. Mô hình kinh doanh của họ dựa trên việc chạy compute; hỗ trợ worker chạy ngoài làm giảm doanh thu trên mỗi khách hàng và làm phức tạp guarantee của họ. Nhưng không phải bằng không.

Mitigation:

- đi nhanh, chiếm chỗ trước khi họ nhìn về hướng này;
- tập trung self-host và library mode — chỗ họ khó theo vì kiến trúc cloud-first;
- provider operations và verified tasks — chỗ họ chưa có kế hoạch;
- NestJS-first DX;
- nếu điều này xảy ra: rút về provider operations + verified tasks làm cửa vào chính.

## 30.6. Sync engine làm "convergence" mất giá trị

Trigger.dev đã dùng ElectricSQL. Nếu Electric hoặc Zero trở thành cách chuẩn để đồng bộ Postgres xuống client, thì reducer tự viết của RhinoQ không còn là điểm mạnh.

Mitigation:

- coi sync engine là **một transport**, không phải đối thủ (mục 6.7);
- nếu Electric thắng, thêm `ElectricTransport` implement `TaskTransport` và giữ nguyên phần còn lại;
- giá trị của RhinoQ nằm ở *task semantics*, không ở cơ chế đồng bộ.

Đây là lý do transport phải là interface ngay từ V1, không phải refactor sau.

## 30.7. Delivery layer bị đánh giá là mỏng

"SSE thì tôi tự viết trong hai ngày." Đây là phản ứng sẽ gặp trên HN.

Mitigation:

- không bao giờ bán delivery như tính năng độc lập;
- demo phải cho thấy đúng những chỗ tự viết sẽ sai: multiplexing, attempt versioning, coalescing, terminal convergence;
- có sẵn một trang "what breaks when you build this yourself" với ví dụ chạy được.

## 30.8. Một người không bảo trì được nhiều SDK

Mitigation:

- HTTP protocol;
- Node only ban đầu;
- generated clients sau;
- community adapters.

## 30.9. Library mode và service mode phân kỳ

Hai mode dễ trôi thành hai sản phẩm.

Mitigation:

- cùng một core, khác nhau chỉ ở lớp bootstrap;
- test suite chạy trên cả hai mode;
- không có tính năng nào chỉ có ở một mode mà không công bố rõ.

---

# 31. README mới nên đổi thế nào?

## Hero

```text
# RhinoQ

Your queue stays. Your workers stay. Add the user-facing layer.

Task lifecycle · converging realtime · cancellation · retries · streams · partial results
```

Ngay dưới hero, một đoạn ba dòng giải thích cơ chế — vì dev audience mua bằng cơ chế, không mua bằng lời hứa:

```text
Snapshot-first: your frontend subscribes to a versioned entity, not a stream.
SSE when it works, polling when it doesn't, and a full page reload still lands
on the correct state — because the source of truth is a Postgres row.
```

## Quick demo

Ba khối, theo thứ tự backend → worker → frontend:

```ts
// 1. Backend
const task = await rhinoq.tasks.enqueue("export-report", {
  ownerId: user.id,
  input,
});
```

```ts
// 2. Worker — BullMQ của bạn, không đổi gì
rhinoq.attachWorker(existingBullMQWorker);

await ctx.progress(50);
await ctx.complete({ resultRef });
```

```tsx
// 3. Frontend
const { task, cancel, retry } = useRhinoTask(taskId);
```

Khối thứ hai là khối quan trọng nhất. Nó phải xuất hiện trong 30 giây đầu người đọc nhìn thấy README.

## Ngay sau quickstart

Một bảng so sánh ngắn, không né tránh:

```text
Trigger.dev / Inngest / Hatchet   → bạn viết task theo SDK của họ, chạy trên runtime của họ
RhinoQ                            → bạn giữ nguyên queue và worker, thêm lớp user-facing
```

Kèm câu trung thực: *"If you're happy to migrate your workload, Trigger.dev and Inngest are excellent and more mature. RhinoQ exists for teams who aren't."*

Câu này làm tăng độ tin cậy nhiều hơn là mất khách.

## Sau đó mới giới thiệu

- BullMQ Connect + bảng công bố guarantee (mục 14.6);
- Library mode;
- Streams;
- Native PostgreSQL Runtime;
- Redis scaled realtime;
- Provider Operations;
- Verified Tasks.

## Không đặt đầu README

- SQL Rule;
- integrity-only;
- payment reconciliation;
- COMMIT/RUN/VERIFY/RECOVER.

Các phần đó chuyển xuống:

```text
Advanced reliability
```

---

# 32. Thông điệp marketing đề xuất

## Primary

> **Your queue stays. Your workers stay. Add the user-facing layer.**

## Technical (HN, dev forums)

> **Snapshot-first task state. The transport is a detail.**

## Existing BullMQ

> **Connect BullMQ to your frontend without building task status APIs and realtime plumbing.**

## Delivery

> **One connection, many tasks, and a state that converges no matter how it got there.**

## Stream

> **Progress for the state. Streams for the tokens. Both from the same task.**

## Provider

> **Run, poll and recover external provider operations through the same task lifecycle.**

## Verified

> **Do not tell users a task is done until its result is actually ready.**

## Câu không nên dùng nữa

> ~~Stop rebuilding background task infrastructure.~~

Trigger.dev và Inngest đã dùng thông điệp này suốt hai năm. Dùng lại là tự đặt mình vào thế so sánh trực diện ở chỗ họ mature hơn.

---

# 33. Quyết định cuối cùng

## Ý tưởng có tốt không?

Có, với điều kiện sản phẩm được xây theo end-to-end lifecycle chứ không dừng ở SSE.

## Có giúp backend không?

Có, nếu xóa được:

- task state;
- API;
- scheduler polling provider;
- retry/cancel;
- history;
- result;
- event delivery;
- auth.

## Có giúp frontend không?

Có, nếu frontend chỉ cần hook/client và không tự quản lý transport/state convergence.

## Có tận dụng code cũ không?

Có:

- runtime;
- retry;
- cancellation;
- fencing;
- attempts;
- PostgreSQL adapters;
- gateway;
- Node SDK;
- Effect Ledger;
- Findings;
- Workbench.

## Có cần bỏ định hướng cũ không?

Bỏ nó khỏi cửa vào sản phẩm, không bỏ code và năng lực.

## Có nên phụ thuộc BullMQ không?

Không. BullMQ là adapter hạng nhất, không phải core.

## Có nên phụ thuộc PostgreSQL không?

Native runtime dùng PostgreSQL. Task integration vẫn dùng được với mọi application database và external runtime.

## Có nên dùng Redis?

Có. Redis là first-class hot layer và runtime option qua BullMQ, nhưng PostgreSQL giữ durable truth.

## Có nên tự viết reducer thay vì dùng sync engine?

Chưa quyết. Xem mục 39.1. Nhưng transport phải là interface từ V1 để giữ được cả hai đường.

## Delivery có phải là thứ đáng bán không?

Bản thân SSE thì không. Thứ đáng bán là những gì transport không biết: ownership, attempt versioning, multiplexing, coalescing, terminal convergence. Không bao giờ quảng bá delivery như một tính năng độc lập.

## Phạm vi cuối cùng

```text
RhinoQ
├── Tasks
│   ├── lifecycle, attempts, steps
│   ├── items
│   └── streams
├── Delivery
│   ├── snapshot API
│   ├── TaskTransport (SSE · WS · Poll · sync engine)
│   ├── ConnectionManager (multiplexing)
│   ├── RealtimeBus (NOTIFY · Redis)
│   └── Coalescer
├── Execution
│   ├── Native Runtime
│   ├── Runtime Connectors (BullMQ · HTTP · …)
│   └── Liveness contract
├── Provider Operations
├── Result Management
└── Verified Tasks
```

## Deployment cuối cùng

```text
Library mode   ← mode được test đầu tiên, phục vụ adoption
Service mode   ← phục vụ nhiều service dùng chung
```

---

# 34. Thứ tự công việc thực hiện ngay

### Trước khi viết dòng code nào

1. Chốt license và business model (mục 38). Quyết định này ảnh hưởng tới kiến trúc.
2. Trả lời câu hỏi sync engine ở mục 39.1. Nếu câu trả lời là "dùng Electric", phần lớn mục 8 đổi.
3. Viết ADR chốt pivot, kèm bảng so sánh trung thực với ba đối thủ.

### Task Core

4. Tạo `internal/domain/task`.
5. Định nghĩa state machine và invariants.
6. Tạo migrations cho Task/Attempt/Execution link + chỉ mục mục 18.10.
7. Tạo Task API snapshot.
8. Tạo progress command có attempt/version.
9. Tạo task event store + retention job.

### Delivery — làm reducer trước transport

10. Viết reducer thuần trước tiên, cùng property test cho bốn bất biến ở mục 17.3. **Không mở network cho tới khi reducer xanh.**
11. Định nghĩa `TaskTransport` interface.
12. `PollingTransport` trước — đơn giản nhất, kiểm chứng reducer.
13. `SseTransport` sau.
14. `ConnectionManager` với multiplexing.
15. `RealtimeBus` port + adapter `notify`.
16. Coalescer ở gateway.
17. React hook + `RhinoProvider`.

### Sản phẩm chạy được

18. Thêm cancel/retry/result + token scope mới.
19. **BullMQ adapter + adapter heartbeat + bảng guarantee.** Sớm, không để sau.
20. Library mode `@rhinoq/nestjs`.
21. Demo video scraper theo kịch bản mục 23.4.
22. Kiểm thử reconnect/race/multiplexing.

### Sau đó

23. Stream channel + demo AI generation.
24. Task Items.
25. Redis bus + WebSocket transport.
26. Provider Operations.
27. Verified Tasks.

> Thay đổi quan trọng nhất so với bản v1: **reducer đi trước transport** (bước 10), và **BullMQ lên bước 19** thay vì nằm sau Items.

---

# 35. Definition of Done cho V1

V1 chỉ được coi là hoàn thành khi demo được toàn bộ:

### Lifecycle

1. Tạo task từ NestJS.
2. RhinoQ Native enqueue.
3. Worker nhận task.
4. Frontend hiển thị queued/running.
5. Progress cập nhật.
6. Retry tạo attempt mới.
7. Event cũ không ghi đè attempt mới.
8. Cancel active worker.
9. Completed trả JSON result.
10. Task xuất hiện trong history.

### Delivery

11. Reload không mất state.
12. `transport: "auto"` — mất SSE thì degrade sang polling, hồi phục thì hội tụ.
13. `transport: "sse"` — mất SSE thì `connection.status = "error"`, **không** tự degrade, state trên màn hình giữ nguyên.
14. 20 task trên một màn hình dùng đúng **một** kết nối.
15. Coalescer nén 10.000 progress event xuống dưới 100 message.
16. Hai tab cùng theo dõi một task hội tụ về cùng state.
17. Gateway restart giữa chừng, client tự hội tụ lại.

### Stream

18. Token chảy ra qua `useRhinoTaskStream`.
19. Reload giữa chừng, replay từ offset.
20. Offset hết hạn thì client biết mình mất chunk, không giả vờ đủ.

### Adapter

21. Một BullMQ worker có sẵn được `attachWorker` mà không sửa business logic.
22. Kill worker đó, task chuyển `stalled` trong ngưỡng cấu hình.
23. Bảng công bố guarantee có trong README.

### Deployment

24. Library mode chạy được với đúng PostgreSQL của app, không cần Redis, không cần container thêm.

### Đúng đắn dưới lỗi

25. Tạo task OK nhưng enqueue lỗi → task ở `pending_dispatch`, reconciler bind lại được, không treo vĩnh viễn.
26. Enqueue OK nhưng link lỗi → không sinh job thứ hai khi chạy lại (idempotency key).
27. Cancel và complete tới cùng lúc → kết quả đúng theo `cancellationPolicy`, không phụ thuộc thứ tự đến.
28. Gọi retry hai lần cùng `commandId` → đúng một attempt.
29. **Tắt hẳn RhinoQ, BullMQ worker vẫn chạy xong job; bật lại thì trạng thái hội tụ đúng.**
30. Reload khi Redis đang có progress mới hơn Postgres → UI không tụt lùi.

### Security và vận hành

31. User khác không đọc được task, và nhận 404 chứ không phải 403.
32. Token hết hạn giữa chừng thì refresh không mất subscription.
33. Gửi `ownerId` giả từ frontend không leo được quyền.
34. Secret trong input không xuất hiện trong bảng event.
35. QA xem được Developer Inspector.
36. Không task nào cần controller status riêng.

---

# 36. Nguồn tham khảo chính

- RhinoQ repository: https://github.com/madebyduy/RhinoQ
- RhinoQ README: https://raw.githubusercontent.com/madebyduy/RhinoQ/main/README.md
- RhinoQ architecture: https://raw.githubusercontent.com/madebyduy/RhinoQ/main/ARCHITECTURE.md
- RhinoQ status: https://raw.githubusercontent.com/madebyduy/RhinoQ/main/.ai/STATUS.md
### Queue và runtime

- BullMQ workers/progress/cancellation: https://docs.bullmq.io/guide/workers
- BullMQ events: https://docs.bullmq.io/guide/events
- Bull Board (để đối chiếu phạm vi admin vs user-facing): https://github.com/felixmosh/bull-board

### Đối thủ trực tiếp

- Trigger.dev Realtime: https://trigger.dev/product/realtime
- Trigger.dev React hooks: https://trigger.dev/docs/realtime/react-hooks/overview
- Trigger.dev streaming: https://trigger.dev/docs/tasks/streams
- Inngest Realtime: https://www.inngest.com/docs/features/realtime
- Inngest useRealtime (v4): https://www.inngest.com/docs/features/realtime/react-hooks
- Inngest changelog: https://www.inngest.com/changelog
- Hatchet: https://docs.hatchet.run/v1
- Hatchet self-hosting: https://docs.hatchet.run/self-hosting

### Durable execution (để định vị, không cạnh tranh trực tiếp)

- DBOS (mô hình library mode): https://www.dbos.dev/compare/dbos-vs-temporal

### Transport và stream resumption

- Vercel `resumable-stream`: https://github.com/vercel/resumable-stream
- AI SDK resume streams: https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams
- Phân tích giới hạn của SSE cho session recovery: https://ably.com/blog/ai-chat-stream-resumption

---

# 37. Tuyên bố định hướng ngắn gọn để giữ team không đi lệch

> **RhinoQ exists to make user-facing asynchronous work easy to build and safe to operate.**
>
> Business logic remains in the application. RhinoQ owns the reusable infrastructure around it:
>
> ```text
> task lifecycle
> execution
> provider operations
> progress
> cancellation
> retries
> partial results
> result delivery
> realtime convergence
> history
> verification
> ```
>
> Mọi tính năng mới phải trả lời được ít nhất một trong hai câu hỏi:
>
> 1. Nó có giúp developer thêm một long-running feature nhanh hơn không?
> 2. Nó có làm task đang chạy an toàn, dễ theo dõi hoặc dễ phục hồi hơn không?
>
> Nếu không trả lời được một trong hai câu hỏi trên, tính năng đó không thuộc ưu tiên hiện tại của RhinoQ.

---

# 38. License và mô hình kinh doanh

> Thiếu hoàn toàn trong bản v1. Đây là quyết định phải chốt **trước** khi viết code, vì nó ảnh hưởng tới kiến trúc: nếu có bản thương mại thì ranh giới module phải vạch từ đầu, không refactor sau.

## 38.1. Bối cảnh

Hatchet chọn MIT 100% và biến điều đó thành lợi thế cạnh tranh — người ta tin tưởng self-host vì biết không bị đổi license giữa chừng. Trigger.dev và Inngest đi hướng open core với cloud là nguồn thu.

RhinoQ là dự án một người. Điều đó loại bỏ một số lựa chọn.

## 38.2. Ba phương án

### A. MIT toàn bộ

- Dễ adopt nhất, đúng với tệp người dùng "không muốn migrate, không muốn phụ thuộc vendor".
- Không có đường kiếm tiền trực tiếp.
- Rủi ro: một công ty lớn fork và làm tốt hơn.

### B. Open core

- Core MIT: Task, delivery, adapter, stream.
- Thương mại: Task Center đa tenant, RBAC/SSO, Mapping Workbench, Verified Tasks, provider connector.
- Ranh giới phải rõ từ đầu, nếu không sẽ đau khi tách.

### C. BSL / Elastic License

- Bảo vệ khỏi cloud provider.
- **Trả giá đắt về adoption**, đặc biệt với đúng tệp người dùng của RhinoQ — nhóm chọn self-host thường dị ứng với license không phải OSI.

## 38.3. Khuyến nghị

**Phương án B, nhưng bắt đầu bằng A trên thực tế.**

Cụ thể: license MIT cho toàn bộ những gì có trong V1 và V2. Không tách module thương mại nào cho tới khi có ít nhất 5 người dùng thật đang chạy production. Nhưng **vạch sẵn ranh giới trong cấu trúc thư mục ngay từ đầu** để việc tách sau này không phải viết lại.

Lý do: ở giai đoạn zero-user, rủi ro lớn nhất không phải bị copy mà là không ai dùng. Mọi ma sát adoption đều phải bỏ.

## 38.4. Điều phải quyết ngay

```text
[ ] Chọn license và ghi vào LICENSE ở commit đầu
[ ] Ghi rõ trong README rằng license sẽ không đổi cho phạm vi V1/V2
[ ] Vạch ranh giới module thương mại trong cấu trúc thư mục
[ ] Quyết định có nhận contribution với CLA hay không
```

---

# 39. Câu hỏi mở phải trả lời trước khi code

Sáu câu dưới đây chưa có câu trả lời trong tài liệu này. Chúng không phải chi tiết triển khai — chúng có thể làm đổi kiến trúc.

## 39.1. Vì sao không dùng sync engine cho delivery?

Trigger.dev xây Realtime trên ElectricSQL. Nếu Electric hoặc Zero giải quyết được convergence một cách generic trên Postgres, thì reducer tự viết của RhinoQ phải chứng minh nó thắng ở điểm nào.

Ba khả năng:

| Lựa chọn | Hệ quả |
|---|---|
| Tự viết reducer + transport | Kiểm soát hoàn toàn, không thêm dependency, nhưng phải tự lo scale và đúng đắn |
| Dùng Electric làm transport | Tiết kiệm rất nhiều công, nhưng buộc người dùng chạy Electric và phụ thuộc logical replication |
| Tự viết, nhưng `ElectricTransport` là một implementation của `TaskTransport` | Giữ được cả hai đường. **Khả năng này chỉ mở ra nếu transport là interface từ V1** |

Đây là lý do mục 6.7 tồn tại. Nhưng câu trả lời chính thức vẫn cần được viết ra thành ADR.

## 39.2. Library mode có thực sự khả thi với multiplexing không?

Library mode chạy trong process của app. Nếu app deploy nhiều instance sau load balancer, một client cắm vào instance nào cũng phải nhận đủ event — nghĩa là vẫn cần `RealtimeBus` chạy giữa các instance. LISTEN/NOTIFY giải quyết được, nhưng phải benchmark với số instance thực tế.

Nếu không khả thi, library mode phải giới hạn ở single-instance và công bố rõ.

## 39.3. Ai là người dùng thứ nhất, cụ thể?

Không phải "team NestJS dùng BullMQ" — đó là mô tả tệp, không phải người. Cần một người cụ thể, có sản phẩm thật, có từ 2 task long-running trở lên, chịu thử bản alpha và nói thật.

**Nếu không tìm được người này trong 2 tuần, đó là tín hiệu về nhu cầu, không phải về marketing.**

## 39.4. Bao nhiêu code người dùng thực sự xóa được?

Mục 30.2 nêu rủi ro "abstraction không giảm code" nhưng chưa có cách đo. Cần một baseline cụ thể: lấy một dự án thật đang có 3 long-running task, đếm số dòng và số file liên quan đến task plumbing, rồi làm lại bằng RhinoQ và đếm lại.

Nếu con số không giảm ít nhất 60%, định vị sai.

## 39.5. Stream có nên nằm trong RhinoQ không?

Có lập luận ngược: stream là bài toán đã có `resumable-stream` và Ably giải, và nhét vào RhinoQ làm phình phạm vi.

Lập luận giữ: stream gắn với task (attempt, terminal, retry, resultRef). Tách ra thì người dùng lại phải tự nối hai hệ thống — đúng cái RhinoQ tồn tại để tránh.

Quyết định tạm thời: giữ, nhưng ở mức tối thiểu, và cho phép cắm buffer backend bên ngoài.

## 39.6. Native Runtime có nên tồn tại không?

Đây là câu khó nhất. Native Runtime là phần code sẵn có và mạnh nhất của repo hiện tại, nhưng nó cũng kéo RhinoQ vào cạnh tranh trực diện với Hatchet — chỗ RhinoQ yếu hơn.

Ba lựa chọn:

- **Giữ, quảng bá mạnh** — cạnh tranh trực tiếp, rủi ro cao.
- **Giữ, không quảng bá** — dùng cho người chưa có queue, nhưng cửa vào vẫn là adapter. *(khuyến nghị)*
- **Bỏ, chỉ làm task layer** — gọn nhất, nhưng vứt bỏ tài sản lớn nhất của repo.

Khuyến nghị phương án hai. Diễn đạt chính thức:

> **RhinoQ là một Task Platform. Bạn kết nối runtime hiện có, hoặc dùng Native Runtime khi cần guarantee sâu hơn.**

Cách nói này giải quyết mâu thuẫn định vị: Native Runtime là **một execution backend**, không phải bản sắc sản phẩm. "RhinoQ không thay queue của bạn" và "Native Runtime có guarantee mạnh nhất" cùng đúng, vì câu thứ hai nói về một tùy chọn, không phải về mặc định.

Hệ quả lên tài liệu và README:

- README không mở đầu bằng Native Runtime;
- bảng capability (14.6) đặt Native và BullMQ ngang hàng, khác nhau ở giá trị chứ không ở địa vị;
- roadmap không ưu tiên Native Runtime hơn adapter;
- nhưng docs có một trang riêng cho Native, đủ sâu để người cần guarantee mạnh tìm thấy.

---

# 40. Protocol và compatibility versioning

> Thiếu trong bản v2.0. RhinoQ sẽ có server, Node SDK, React SDK, NestJS module, worker adapter, nhiều transport, library mode và service mode. **Chúng không bao giờ được nâng cấp cùng lúc.** Không định nghĩa versioning từ đầu thì phiên bản thứ ba là lúc mọi thứ vỡ.

## 40.1. Bảy trục version

```text
apiVersion              /v1/...
eventSchemaVersion      envelope của event
snapshotSchemaVersion   hình dạng snapshot trả về
taskDefinitionVersion   theo từng definition (7.10)
adapterProtocolVersion  hợp đồng giữa server và runtime adapter
migrationVersion        schema database
sdkCompatibilityRange   SDK nào chạy được với server nào
```

## 40.2. Event envelope có version

```json
{
  "schemaVersion": 1,
  "eventId": "evt_123",
  "type": "task.snapshot.changed",
  "taskId": "task_123",
  "attempt": 2,
  "entityVersion": 42,
  "occurredAt": "2026-07-29T...",
  "traceId": "...",
  "correlationId": "...",
  "causationId": "...",
  "payload": {}
}
```

Client không hiểu `schemaVersion` cao hơn thì **không được đoán** — bỏ event, fetch snapshot, log cảnh báo một lần.

## 40.3. Quy tắc tương thích

| Thay đổi | Phân loại | Cần làm gì |
|---|---|---|
| Thêm field optional vào payload | additive | không tăng version |
| Thêm event type mới | additive | client cũ bỏ qua type lạ |
| Đổi ý nghĩa field đang có | **breaking** | tăng `schemaVersion`, server phát song song hai version một thời gian |
| Xóa field | **breaking** | deprecate 2 minor, rồi mới xóa |
| Đổi `capabilities` của TaskDefinition | **breaking** | tăng definition version |
| Thêm cột nullable vào DB | additive | migration forward-only |
| Đổi ngữ nghĩa state | **breaking** | cần migration dữ liệu và ADR |

Nguyên tắc: **server mới luôn phục vụ được SDK cũ trong ít nhất hai minor version.** Chiều ngược lại — SDK mới với server cũ — chỉ đảm bảo cho patch version, và SDK phải kiểm tra lúc khởi tạo:

```text
GET /v1/meta
→ { apiVersion, eventSchemaVersion, adapterProtocolVersion, capabilities }
```

Không tương thích thì fail nhanh với thông báo rõ, không chạy rồi hỏng giữa chừng.

## 40.4. Deprecation

```text
1. Đánh dấu deprecated trong docs và response header
2. Phát cảnh báo runtime một lần mỗi process
3. Giữ tối thiểu 2 minor version
4. Xóa ở major version kế tiếp
```

## 40.5. Migration trong library mode

Câu hỏi phải trả lời rõ: **ai chịu trách nhiệm chạy migration?**

```text
Service mode:   RhinoQ tự chạy migration lúc khởi động
Library mode:   ứng dụng chủ động gọi, KHÔNG tự chạy
```

Library mode không được tự migrate, vì:

- app có thể chạy nhiều instance, migrate đồng thời là race;
- app có quy trình migration riêng và muốn kiểm soát thời điểm;
- schema của RhinoQ nằm trong database của app, tự ý đổi là không chấp nhận được.

```ts
await rhinoq.migrate({ to: "latest" });   // gọi trong migration pipeline của app
```

RhinoQ dùng schema riêng (`rhinoq`) để không đụng bảng của app, và fail nhanh nếu phát hiện `migrationVersion` không khớp.

## 40.6. Hai instance khác phiên bản

Trong library mode, app deploy rolling có thể có instance v1.2 và v1.3 chạy song song, cùng đọc một database.

Quy tắc:

- migration phải **forward-compatible**: schema mới phải đọc được bởi code cũ trong ít nhất một version;
- không xóa cột trong cùng release với việc ngừng dùng nó — tách làm hai release;
- event `schemaVersion` mới phải được instance cũ bỏ qua an toàn, không crash.

Đây là ràng buộc thật của library mode và là cái giá phải trả cho việc không có service riêng.

## 40.7. Conformance suite chung cho hai mode

Rủi ro 30.9 (library và service mode phân kỳ) được nâng từ "nguyên tắc tổ chức code" lên **contract có test**:

```text
packages/conformance/
  ├── lifecycle.spec        chạy trên cả hai mode
  ├── delivery.spec
  ├── command-precedence.spec
  ├── dispatch-outbox.spec
  └── adapter/              chạy trên mọi runtime adapter
```

CI chạy toàn bộ suite trên: library mode + PostgreSQL, service mode + PostgreSQL, service mode + PostgreSQL + Redis, và với runtime native + BullMQ. Bốn tổ hợp, cùng một bộ test.
