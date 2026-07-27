# Configuration

Runtime config được đọc qua typed loader tại `internal/infrastructure/config`.

| Variable | Default | Ý nghĩa |
|---|---:|---|
| `RHINOQ_DATABASE_URL` | empty | PostgreSQL connection string |
| `RHINOQ_WORKER_NAME` | hostname-pid | worker identity, ghi vào mọi lease |
| `RHINOQ_CONCURRENCY` | `4` | số handler chạy song song |
| `RHINOQ_PREFETCH_FACTOR` | `1.5` | hệ số nhân slot trống khi claim, tối đa `3` |
| `RHINOQ_MAX_CLAIM_BATCH` | `RHINOQ_CLAIM_LIMIT` | hard cap một lần claim, bảo vệ database |
| `RHINOQ_LEASE_DURATION` | `1m` | thời gian lease |
| `RHINOQ_HEARTBEAT_EVERY` | `lease/3` | khoảng renew lease |
| `RHINOQ_POLL_INTERVAL` | `100ms` | khoảng poll ngắn nhất khi rảnh |
| `RHINOQ_MAX_POLL_INTERVAL` | `2s` | trần backoff khi queue rỗng |
| `RHINOQ_SHUTDOWN_GRACE` | `30s` | thời gian chờ handler tự kết thúc khi dừng |
| `RHINOQ_CANCEL_GRACE` | `10s` | thời gian chờ handler phản hồi cancellation |
| `RHINOQ_REAPER_INTERVAL` | `30s` | khoảng thu hồi lease hết hạn |
| `RHINOQ_MAX_WORKER_CRASHES` | `3` | số lần một job được phép làm worker chết trước khi bị park |
| `RHINOQ_CLAIM_LIMIT` | `10` | deprecated, chỉ còn dùng làm mặc định cho `RHINOQ_MAX_CLAIM_BATCH` |

## Ràng buộc loader từ chối

- Duration không dương, hoặc heartbeat dài hơn/bằng lease.
- `RHINOQ_MAX_POLL_INTERVAL` ngắn hơn `RHINOQ_POLL_INTERVAL`.
- `RHINOQ_PREFETCH_FACTOR` vượt `3`. Job prefetch giữ lease trong lúc chờ slot; hệ số cao làm lease hết hạn trước khi job kịp chạy.
- `RHINOQ_MAX_CLAIM_BATCH` vượt `1000`.

## Batch size không phải hằng số

Số job claim mỗi vòng bằng `slot trống × prefetch factor`, giới hạn bởi `RHINOQ_MAX_CLAIM_BATCH`. Đây là quy tắc duy nhất; không có batch size cố định ở chỗ nào khác.

```text
concurrency 20 · đang chạy 18 · slot trống 2 · prefetch 1.5 → claim 3
```

## Worker identity

`RHINOQ_WORKER_NAME` được ghi vào `lease_owner`. Fencing dùng cặp `(lease_owner, lease_epoch)` nên hai process trùng tên vẫn phân biệt được qua epoch, nhưng log và Needs Attention sẽ khó đọc. `rhinoq doctor` cảnh báo nếu biến này rỗng.

## Kiểm tra cấu hình

```bash
rhinoq doctor        # báo cáo: configuration, fencing, timing, database
rhinoq doctor --ci   # exit code khác 0 nếu có mục FAIL
```
