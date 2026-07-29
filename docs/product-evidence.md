# Product evidence and validation log

Reviewed: 2026-07-29.

Tài liệu này ghi bằng chứng dùng để quyết định roadmap. Nó không phải marketing
copy. Capability của đối thủ chứng minh vấn đề tồn tại và có thể được giải;
không tự động chứng minh người dùng sẽ chọn RhinoQ.

## Điều thị trường đã chứng minh

Các nền tảng task hiện tại đều đóng gói một nhóm nhu cầu giống nhau:

- BullMQ cung cấp worker, progress, result, retry, cancellation signal và global
  queue events. Điều này chứng minh queue lifecycle là nền tảng, nhưng frontend
  application vẫn phải tự xây task ownership, snapshot và result delivery.
  Nguồn: [BullMQ workers](https://docs.bullmq.io/guide/workers).
- Trigger.dev cung cấp long-running task, retry, realtime, streaming, React
  hooks, tracing và versioning. Hatchet cung cấp durable task, retry, scheduling,
  dashboard và worker orchestration. RhinoQ không được định vị bằng danh sách
  các feature này vì đối thủ đã làm sâu.
  Nguồn: [Trigger.dev repository](https://github.com/triggerdotdev/trigger.dev),
  [Hatchet repository](https://github.com/hatchet-dev/hatchet).
- Thảo luận thiết kế Trigger.dev v3 ghi nhận chi phí của framework/runtime
  integration, output round trips và versioning khi platform phải gọi ngược vào
  deployment của người dùng. Đây là bằng chứng hỗ trợ việc giữ adapter boundary,
  không phải bằng chứng RhinoQ đã giải được nó.
  Nguồn: [Trigger.dev discussion #784](https://github.com/triggerdotdev/trigger.dev/discussions/784).
- Việc cancel một active BullMQ job từ producer từng buộc người dùng tự phối hợp
  bằng QueueEvents/progress listeners. Đây là ví dụ về khoảng cách giữa queue
  primitive và user-facing task command.
  Nguồn: [BullMQ discussion #1106](https://github.com/taskforcesh/bullmq/discussions/1106).

## Provider operation là pain thật

Async provider integration lặp lại cùng một failure model ở nhiều hệ thống:

- AWS ghi rõ mutating request có thể trả về trước khi workflow bất đồng bộ hoàn
  tất; timeout có thể khiến caller không biết request có thành công hay không,
  và retry không idempotent có thể tạo resource nhiều lần.
  Nguồn: [EC2 API idempotency](https://docs.aws.amazon.com/ec2/latest/devguide/ec2-api-idempotency.html).
- Azure mô tả async request-reply bằng status resource, `Location`,
  `Retry-After`, cancellation và idempotency key để duplicate POST trả lại cùng
  status resource.
  Nguồn: [Asynchronous Request-Reply pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/asynchronous-request-reply).
- Google Cloud dùng operation ID và polling cho long-running operation.
  Nguồn: [Google long-running operations](https://docs.cloud.google.com/gemini/enterprise/docs/long-running-operations).
- Stripe khuyến nghị webhook cho trạng thái payment bất đồng bộ, cảnh báo polling
  kém tin cậy/rate limiting, và yêu cầu coi một số server error là indeterminate
  thay vì retry bằng key mới.
  Nguồn: [Payment status updates](https://docs.stripe.com/payments/payment-intents/verifying-status),
  [advanced error handling](https://docs.stripe.com/error-low-level).

Kết luận kiến trúc: ProviderOperation có giá trị nếu nó chuẩn hóa operation ID,
idempotency, poll/webhook, timeout, confirmation và `uncertain`. Nó không nên
chứa business mapping hoặc trở thành marketplace connector trong V1.

## Giả thuyết RhinoQ chưa chứng minh

| Hypothesis | Evidence cần có | Fail signal |
|---|---|---|
| Giữ queue/worker làm adoption dễ hơn | 3 ứng dụng tích hợp mà không đổi business handler | vẫn phải viết lại worker hoặc thêm nhiều glue hơn đối thủ |
| Task layer giảm code BE/FE | so sánh file/LOC/endpoints trước và sau trên một app có ít nhất 2 task | giảm dưới 50% plumbing hoặc vẫn cần controller status riêng |
| Snapshot version giải reconnect/retry | property test và browser test với stale event, reload và retry | UI tụt version hoặc terminal state bị ghi đè |
| ProviderOperation reusable | hai provider khác semantics dùng cùng core contract | adapter phải chứa state machine riêng hoặc core đầy provider-specific branch |
| Người dùng cần Verified Tasks | một task production dùng effect/outcome evidence để bắt mismatch thật | chỉ dùng progress bar, không dùng verification lần hai |

Không được chuyển các hypothesis này thành claim trong README trước khi có
evidence tương ứng.

## MVP được research ủng hộ

Giữ trong đường găng:

1. Task identity, ownership và versioned snapshot.
2. Execution adapter boundary, bắt đầu native và BullMQ.
3. Progress, cancel, retry, history và result availability.
4. Polling trước realtime để kiểm chứng state contract.
5. ProviderOperation generic sau Task lifecycle.
6. Verified Tasks tùy chọn cho effect/outcome quan trọng.

Hoãn:

- DAG/workflow builder;
- nhiều frontend framework;
- WebSocket/Redis scale trước benchmark;
- provider marketplace;
- AI root-cause;
- tuyên bố throughput hoặc code reduction khi chưa đo.
