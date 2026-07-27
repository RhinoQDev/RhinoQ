# Configuration

Runtime config được đọc qua typed loader tại `internal/infrastructure/config`.

| Variable | Default | Ý nghĩa |
|---|---:|---|
| `RHINOQ_DATABASE_URL` | empty | PostgreSQL connection string |
| `RHINOQ_WORKER_NAME` | empty | worker identity |
| `RHINOQ_CLAIM_LIMIT` | `10` | số job claim mỗi poll |
| `RHINOQ_CONCURRENCY` | `4` | số handler chạy song song |
| `RHINOQ_LEASE_DURATION` | `1m` | thời gian lease |
| `RHINOQ_POLL_INTERVAL` | `1s` | khoảng poll |
| `RHINOQ_HEARTBEAT_EVERY` | `lease/3` | khoảng renew lease |
| `RHINOQ_REAPER_INTERVAL` | `1m` | khoảng thu hồi lease hết hạn |

Loader từ chối config có duration không dương hoặc heartbeat dài hơn lease.

