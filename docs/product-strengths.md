# RhinoQ product strengths

Reviewed: 2026-07-29

Tài liệu này tách ba khái niệm thường bị trộn lẫn:

- **implemented strength:** đã có code và test;
- **architectural advantage:** boundary cho phép phát triển theo hướng đó;
- **product claim:** chỉ được nói khi ứng dụng thật chứng minh người dùng nhận
  được giá trị.

## Điểm mạnh đã có evidence

### Một contract Task xuyên BE và FE

Go application dùng `pkg/rhinoq`; service khác ngôn ngữ và frontend có thể dùng
HTTP Snapshot v1 hoặc typed Node client. Cùng một contract chứa lifecycle,
known/indeterminate progress, result availability, Execution binding và
monotonic aggregate entity version.

Evidence:

- `pkg/rhinoq/tasks.go`;
- `internal/interfaces/agent/server.go`;
- `sdks/node/src/gateway/client.ts`;
- unit/integration tests cho polling, stale write và result reference.

Giới hạn: chưa có React hook, SSE/WebSocket hoặc browser reconnect test.

### Correctness không bị nhân bản sang SDK

Lease/fencing, retry classification, DB clock, Effect Ledger và Task state
transition nằm trong Go engine/Application. Node SDK gửi intent và observation,
không tự quyết định authoritative state.

Giới hạn: adapter runtime ngoài chưa tồn tại, vì vậy lợi ích “giữ BullMQ
worker” vẫn là architectural direction chứ chưa phải adoption evidence.

### Fail-closed cho stale và unknown

- Task mutation dùng expected entity version;
- create/bind Execution tăng cùng aggregate version trong memory lock hoặc
  PostgreSQL transaction;
- worker write dùng lease owner + epoch;
- external effect có `uncertain`, không retry mù;
- callback/provider acceptance không tự động thành business outcome.

Điểm mạnh này trực tiếp giảm khả năng một response cũ hoặc worker cũ ghi đè
state mới. Nó không đồng nghĩa exactly-once cho external provider.

### Verified Tasks là capability tùy chọn

Task, Execution, Job, Effect, Outcome và Finding là state machine riêng. Một
feature chỉ cần progress bar không phải khai báo Rule/Outcome; payment,
provisioning hoặc fulfilment có thể bật evidence mạnh hơn.

Giới hạn: chưa có số liệu cho biết bao nhiêu adopter thực sự dùng lớp Verified
Tasks.

### PostgreSQL là durable truth có thể tự vận hành

Task state, execution history và native Job runtime dùng migration có checksum,
optimistic concurrency và real-PostgreSQL contract tests. Redis không phải
nguồn truth bắt buộc.

Giới hạn: chưa có benchmark, fault campaign, retention hoặc partition evidence;
không được suy ra throughput/reliability production từ architecture.

## Lợi thế kiến trúc chưa được gọi là product claim

| Potential advantage | Vì sao hợp lý | Bằng chứng còn thiếu |
|---|---|---|
| giữ queue/worker hiện tại | Execution có external runtime reference, correctness không nằm trong SDK | BullMQ adapter và một app tích hợp thật |
| giảm status/progress/result plumbing | public Snapshot/result contract dùng lại được cho nhiều Task type | before/after app có ít nhất hai Task |
| FE không tụt state khi reconnect | entity version cho phép bỏ response cũ | property test và browser reload/reorder test |
| provider async dùng chung một model | effect semantics đã có accepted/confirmed/uncertain | ProviderOperation áp dụng cho hai provider khác nhau |
| task quan trọng có evidence mạnh hơn queue | Effect/Outcome/Rule/Finding đã có | mismatch production hoặc reference workload end-to-end |

## Thông điệp sản phẩm được phép dùng hiện tại

> RhinoQ cung cấp một Task snapshot có version cho Go/HTTP/Node, giữ runtime
> correctness trong Go/PostgreSQL và cho phép bật thêm business verification
> khi Task có external effect quan trọng.

Chưa được dùng:

- “giảm 50% code”;
- “drop-in cho BullMQ”;
- “production-ready”;
- throughput/latency/reliability claim;
- “exactly once external effects”.
