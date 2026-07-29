# Task Platform

Tài liệu này là contract triển khai tăng dần cho Task Platform. Nó phân biệt
rõ phần đã có code với phần mới là kế hoạch. Product baseline đầy đủ nằm ở
[`../.ai/PRODUCT_BASELINE.md`](../.ai/PRODUCT_BASELINE.md), quyết định kiến trúc
nằm ở ADR-0014 trong [`../.ai/DECISIONS.md`](../.ai/DECISIONS.md).

## Mô hình

```text
Task 1:N Execution
Execution 0:1 native Job
Execution 0:1 external runtime reference
Execution 0:N ProviderOperation        (planned)
Task 0:1 VerifiedTaskPolicy            (planned)
```

- `Task` là thực thể user-facing: type, owner, lifecycle, progress, result và
  version dùng để tạo snapshot.
- `Execution` là một attempt thực thi Task. Retry tạo Execution mới.
- `Job` là primitive của native Go/PostgreSQL runtime hiện có.
- Runtime ngoài như BullMQ dùng stable external execution ID, không giả vờ có
  lease/fencing guarantee của native Job.
- `ProviderOperation` sẽ theo dõi request bất đồng bộ tới provider, nhưng không
  sở hữu business logic của application.

## Trạng thái triển khai

| Capability | Trạng thái | Evidence |
|---|---|---|
| Task lifecycle domain | implemented, unit-tested | `internal/domain/task` |
| Task version/progress/result reference | implemented, unit-tested | `internal/domain/task/record.go` |
| Execution lifecycle và immutable runtime binding | implemented, unit-tested | `internal/domain/execution` |
| Native Job runtime | implemented, integration-tested | `internal/domain/job`, `internal/runtime`, `tests/integration` |
| Task/Execution store ports | implemented, unit-tested | optimistic version checks và atomic attempt allocation |
| Memory adapter | implemented, unit-tested | create/update/read Task và Execution |
| Application Task service | implemented, unit-tested | create Task, public create/bind Execution, read Snapshot |
| Versioned Snapshot DTO | implemented, contract-tested | không lộ owner hoặc runtime reference |
| Lifecycle/progress commands | implemented, unit-tested | expected-version fencing; progress chỉ khi running/cancel requested |
| PostgreSQL store và migration 015 | implemented, real-DB contract passed | optimistic updates; concurrent per-Task attempt allocation has no gaps/duplicates |
| Public Task facade | implemented, unit-tested | create/read/progress/result, create/bind Execution và explicit lifecycle commands |
| Polling delivery | implemented, integration-tested | HTTP `POST/GET /v1/tasks`; typed Node client; stale write trả typed `409` |
| Result-reference delivery | implemented, integration-tested | separate Go/HTTP/Node read-write API; Snapshot chỉ trả `hasResult` |
| BullMQ adapter | planned | external reference contract đã có, adapter chưa có |
| ProviderOperation | planned | boundary đã chốt, model chưa có |
| Verified Task composition | planned | primitives Effect/Outcome/Rule/Finding đã có |

Không được dùng bảng này để quảng bá capability `planned` như behavior hiện có.

## Task lifecycle

```text
pending → queued → running → succeeded
                     └────→ failed → queued (retry)
queued/running → cancel_requested → cancelled
cancelled → queued (explicit retry)
```

`failed/cancelled → queued` hiện là lifecycle primitive. Public composed Retry
command có command identity, tạo Execution mới và xử lý crash giữa hai write
vẫn chưa hoàn thiện; không được coi `QueueTask` là retry end-to-end.

`Task.State` không thay thế `Execution.State`, `Job.State`, `Effect.State` hay
`Outcome.State`. Một job thành công chưa đủ để kết luận business outcome đạt.

Mỗi mutation của Task **hoặc Execution con** tăng `Task.Version`. Memory adapter
làm việc này trong cùng lock; PostgreSQL adapter làm trong cùng transaction với
insert/update Execution. Vì vậy hai Snapshot có cùng `entityVersion` không được
chứa Execution state khác nhau. Delivery tương lai dùng version để bỏ update cũ
sau reconnect/retry, thay vì tin thứ tự arrival của transport.

Progress hỗ trợ hai dạng:

- known total: `completed`, `total`, `hasTotal=true`;
- indeterminate: `completed`, optional message, `hasTotal=false`.

Frontend không được tự bịa phần trăm khi worker không biết total.

Result payload không nằm trong Snapshot. Application ghi một storage reference
qua version-fenced command; client đọc reference bằng endpoint riêng. Cách này
giữ polling response nhỏ và tránh gửi lặp storage location ở mỗi poll. RhinoQ
chưa proxy/download payload và chưa áp tenant-level authorization.

## Execution lifecycle

```text
pending_dispatch → dispatched → running → succeeded | failed | cancelled
                               └───────→ stalled → dispatched | failed | cancelled
```

Runtime binding chỉ được ghi một lần:

- `native` yêu cầu `jobId` và không nhận `externalId`;
- runtime ngoài yêu cầu `externalId` và không nhận `jobId`.

Public Go/HTTP/Node API đã cho phép tạo Execution rồi bind stable runtime
reference. API này chưa tự enqueue native Job hoặc gọi BullMQ; adapter phải làm
việc đó rồi báo reference về Application.

Dispatch lỗi trước khi bind giữ Execution ở `pending_dispatch` để reconciler
tương lai xử lý. Một Execution terminal không được mở lại; retry phải tạo
Execution mới với attempt tăng lên.

## Provider support

ProviderOperation dự kiến chỉ chuẩn hóa hạ tầng dùng lại:

```text
request ID · idempotency key · poll/webhook · timeout
confirmation · uncertain · normalized result reference
```

RhinoQ không coi `202 Accepted` là completion và không retry mù khi kết quả
provider chưa biết. Business payload, quyết định fallback và invariant cuối
cùng vẫn thuộc application hoặc Verified Task policy đã khai báo.

## Slice tiếp theo

1. Tạo một example app có hai Task để đo code/endpoints bị xóa.
2. Nối một runtime adapter thật vào Task → Execution mà không đưa correctness
   sang SDK.
3. Thiết kế ProviderOperation từ hai provider semantics khác nhau.
4. Thêm golden contract/parity gate trước khi mở thêm SDK.
5. Chỉ sau đó mới thêm transport realtime.
