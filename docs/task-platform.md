# Task Platform

> Current status (2026-08-01): this document contains the staged architectural
> history of the Task layer. For the current public integration contract and
> runnable paths, use [Start here](./start-here.md), the
> [Node.js guide](./nodejs.md) and [ProviderOperation](./provider-operations.md).
> The status table below is current; older “next slice” narrative is retained
> only as decision history and must not override implemented code.

Tài liệu này là contract triển khai tăng dần cho Task Platform. Nó phân biệt
rõ phần đã có code với phần mới là kế hoạch. Product baseline đầy đủ nằm ở
[`../.ai/PRODUCT_BASELINE.md`](../.ai/PRODUCT_BASELINE.md), quyết định kiến trúc
nằm ở ADR-0014 trong [`../.ai/DECISIONS.md`](../.ai/DECISIONS.md).

## Mô hình

```text
Task 1:N Execution
Execution 0:1 native Job
Execution 0:1 scoped external runtime reference
Execution 0:N ProviderOperation        (implemented)
Task 0:1 VerifiedTaskPolicy            (planned)
```

- `Task` là thực thể user-facing: type, owner, lifecycle, progress, result và
  version dùng để tạo snapshot.
- `Execution` là một attempt thực thi Task. Retry tạo Execution mới.
- Fan-out dùng `itemKey`; `attempt` tăng riêng cho từng item, không tăng theo
  vị trí item trong batch.
- `Job` là primitive của native Go/PostgreSQL runtime hiện có.
- Runtime ngoài như BullMQ dùng stable external execution ID, không giả vờ có
  lease/fencing guarantee của native Job.
- `ProviderOperation` theo dõi request bất đồng bộ tới provider nhưng không sở
  hữu business logic, credential hay provider SDK của application.

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
| Versioned Snapshot DTO | implemented, contract-tested | trả `ownerId` để application authorize; không lộ runtime reference; shared Go/Node golden fixture locks Snapshot/Result v1 |
| Lifecycle/progress commands | implemented, unit-tested | expected-version fencing; completed không giảm và known total không đổi |
| Idempotent duplicate commands | implemented, contract-tested | progress trùng giá trị và cancellation request lặp không tăng `entityVersion`, không ghi store, không conflict |
| PostgreSQL store và migrations 015–017 | implemented, real-DB contract passed | optimistic updates; cancellation outcome; per-attempt result/failure reason; concurrent per-Task attempt allocation has no gaps/duplicates |
| Task-only PostgreSQL profile | implemented, real-DB tested | đúng 3 bảng trong `rhinoq_task`; command functions; item-scoped attempt; runtime scope; không FK tới native Job |
| Embedded Node Task client | implemented, real-DB tested | dùng `pg.Pool` sẵn có, không Gateway/token/Go toolchain |
| Public Task facade | implemented, unit-tested | create/read/progress/result, create/bind Execution và explicit lifecycle commands |
| Polling delivery | implemented, integration-tested | HTTP `POST/GET /v1/tasks`; typed Node client; stale write trả typed `409` |
| Framework-neutral Node Task watcher | implemented, SDK-tested | non-overlapping polling; only newer aggregate versions are yielded; terminal/abort stop |
| Result-reference delivery | implemented, integration-tested | separate Go/HTTP/Node read-write API; Snapshot chỉ trả `hasResult` |
| BullMQ lifecycle bridge | implemented, Node SDK-tested | reserve-before-enqueue dispatch, bounded fan-out, lifecycle projection, application-owned cancellation; no outage-wide discovery |
| Task Summary and Execution pages | implemented, Go/Node/PostgreSQL tested | stored aggregate counts, default summary polling and stable cursor pages |
| TaskStore and React adapter | implemented, Node SDK-tested | serialized polling, stale-version rejection, bounded reconnect and zero-added-dependency React binding |
| ProviderOperation | implemented, Go/Node/PostgreSQL tested | durable identity, explicit confirmation/retry policy, append-only evidence and `uncertain` fail-closed result |
| Safe repair | implemented, Go/Gateway/Workbench tested | preview, precondition, four-eyes approval, allowlisted callback and post-apply verification |
| Finding notifications | implemented, Go/PostgreSQL tested | signed webhook/Slack delivery with durable destination/event deduplication |
| Verified Task composition | planned | primitives Effect/Outcome/Rule/Finding đã có |

Không được dùng bảng này để quảng bá capability `planned` như behavior hiện có.

## Task lifecycle

```text
pending → queued → running → succeeded
                     └────→ failed → queued (retry)
queued/running → cancel_requested → cancelled
cancelled → queued (explicit retry)
```

Cancellation outcome là state trực giao trong Snapshot. Vì vậy
`cancel_requested → succeeded` trả Task `succeeded` cùng
`cancellation.status = too_late`, không còn giống Task chưa từng được yêu cầu
hủy. Worker/application cũng có thể ghi `acknowledged`,
`cannot_cancel_safely` hoặc `failed` qua command có version fence.

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

Node `watchTask()` hiện thực hóa phần polling này mà không thêm framework hoặc
transport mới. Nó không thay thế tenant authorization, React state management
hay realtime reconnect protocol.

Gateway có hai credential boundary:

- `RHINOQ_AGENT_TOKEN`: operator/runtime, có quyền ghi lifecycle và dùng adapter;
- credential trong `RHINOQ_TASK_CREDENTIALS_JSON`: chỉ đọc Task/result cùng
  `ownerId` và gọi cancellation-request command an toàn.

Owner token đọc/cancel Task khác owner trả `404` để không lộ sự tồn tại, không
thể gọi queue/operator endpoint và không thể tự đặt `succeeded`. Đây là owner
isolation đã test, chưa phải organization membership/RBAC hay chính sách tenant
hoàn chỉnh.

Ví dụ cấu hình evaluation (mỗi token tối thiểu 32 byte):

```json
[
  {
    "ownerId": "tenant-acme",
    "token": "replace-with-a-random-owner-token-at-least-32-bytes"
  }
]
```

Gán JSON trên vào `RHINOQ_TASK_CREDENTIALS_JSON`; không commit token vào source.

Progress hỗ trợ hai dạng:

- known total: `completed`, `total`, `hasTotal=true`;
- indeterminate: `completed`, optional message, `hasTotal=false`.

Frontend không được tự bịa phần trăm khi worker không biết total.

Command ghi trùng là no-op, không phải conflict. Một progress write mang đúng
giá trị đang lưu, và một cancellation request trên Task đã `cancel_requested`,
đều trả `200` với snapshot hiện tại, **không tăng `entityVersion`** và không
chạm store. Hai command này cũng không bị fence: một write không thay đổi gì thì
không thể mất update, nên `expectedVersion` cũ vẫn được chấp nhận. Mọi thay đổi
thật vẫn bị fence như cũ.

Điều này quan trọng vì queue re-deliver event khi reconnect: nếu no-op tăng
version thì `watchTask()` đẩy một snapshot trùng nội dung cho mọi client, và
writer đang giữ version trước đó ăn `RHINOQ_VERSION_CONFLICT` do một bản trùng
gây ra. Ràng buộc này nằm ở domain (`internal/domain/task`), không phải ở HTTP
handler — vá bằng read-then-skip ở edge sẽ race với writer đồng thời.

Result payload không nằm trong Snapshot. Application ghi một storage reference
qua version-fenced command; client đọc reference bằng endpoint riêng. Cách này
giữ polling response nhỏ và tránh gửi lặp storage location ở mỗi poll. RhinoQ
chưa proxy/download payload. Owner-scoped credential đã giới hạn Task/result
theo `ownerId`, nhưng organization membership/RBAC và authorization model đa
tenant hoàn chỉnh chưa có.

## Kết quả từng item

Task giữ **một** aggregate result reference. Fan-out cần một cái cho mỗi item,
nếu không application buộc phải nuôi store per-item song song — và chính store
đó giữ cho lớp plumbing cũ không chết được, tức là Task layer không bỏ hộ việc
gì cả.

Vì vậy mỗi Execution mang thêm:

- `resultRef`: artifact của riêng attempt đó (`POST /v1/task-executions/{id}/result`);
- `failureReason`: prose user-facing cho một item hỏng, ghi kèm khi chuyển sang
  `failed` (`{"state":"failed","reason":"..."}`), bị cắt ở
  `execution.MaxFailureReasonLength` vì nó đi cùng mỗi lần poll.

Snapshot chỉ lộ `hasResult` và `failureReason` cho từng Execution, **không lộ
reference** — cùng nguyên tắc với Task result, vì storage location là thứ nhạy
cảm và không nên gửi lặp ở mỗi poll. Đọc reference bằng
`GET /v1/tasks/{id}/execution-results`, owner-scoped như endpoint result.

Bridge BullMQ map `resultReference` vào Execution trước; ở `single-execution`
thì gắn lên Task luôn vì một job đúng là cả Task. Trước thay đổi này,
`resultReference` bị **bỏ qua hoàn toàn** ở `execution-only` — option có mà
không làm gì, đúng ở chế độ cần nó nhất.

## Execution lifecycle

```text
pending_dispatch → dispatched → running → succeeded | failed | cancelled
                               └───────→ stalled → dispatched | failed | cancelled
```

Runtime binding chỉ được ghi một lần:

- `native` yêu cầu `jobId` và không nhận `externalId`;
- runtime ngoài yêu cầu `externalId` và không nhận `jobId`.

Task-only profile dùng identity `(runtime, runtimeScope, externalId)`. BullMQ
job ID chỉ unique trong một queue, vì vậy `runtimeScope` phải là queue name
hoặc namespace ổn định. Adapter mới reserve identity trước `queue.add()`; crash
để lại `pending_dispatch` và cùng deterministic IDs có thể tiếp tục.

Public Go/HTTP/Node API đã cho phép tạo Execution rồi bind stable runtime
reference. API này chưa tự enqueue native Job hoặc gọi BullMQ; adapter phải làm
việc đó rồi báo reference về Application.

Dispatch lỗi trước khi bind giữ Execution ở `pending_dispatch` để reconciler
tương lai xử lý. Một Execution terminal không được mở lại; retry phải tạo
Execution mới với attempt tăng lên.

Với fan-out, bridge dùng `terminalProjection: 'execution-only'`. Completion
hoặc failure của item chỉ terminalize Execution tương ứng; application sở hữu
điều kiện aggregate (ví dụ ZIP đã tồn tại) và gọi Task terminal command sau đó.
`single-execution` chỉ đúng khi một job đại diện toàn bộ Task.

Option này **bắt buộc, không có default**. Chỉ application biết một job có phải
là cả Task hay không, và đoán `single-execution` cho fan-out sẽ đẩy batch sang
`succeeded` ngay khi item đầu tiên xong — im lặng và không thể sửa, vì Task
terminal không bao giờ mở lại. Bridge từ chối construct nếu thiếu.

## Provider support

ProviderOperation hiện chuẩn hóa hạ tầng dùng lại:

```text
request ID · idempotency key · poll/webhook · timeout
confirmation · uncertain · normalized result reference
```

RhinoQ không coi `202 Accepted` là completion và không retry mù khi kết quả
provider chưa biết. Business payload, quyết định fallback và invariant cuối
cùng vẫn thuộc application hoặc Verified Task policy đã khai báo.

Go/PostgreSQL sở hữu state machine và append-only evidence. Node chỉ gọi
application-owned provider code qua Gateway; HTTP, Stripe và
provisioning/storage là các reference adapter đã test. Webhook authentication
vẫn thuộc application.

## Slice tiếp theo

1. Đo adoption cost và outcome evidence trên ba design partner thật.
2. Hoàn thiện tenant-wide RBAC/isolation trước production claim.
3. Chạy deployment-shaped PostgreSQL/Redis/provider chaos campaign, including
   the durable notification scheduler.
4. Thu thập code-reduction và outcome evidence từ design partners.
5. Chỉ thêm realtime transport nếu polling evidence cho thấy nó cần thiết.
