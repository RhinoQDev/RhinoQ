# HTTP Gateway tùy chọn cho worker đa ngôn ngữ

> Binary hiện mang tên `rhinoq-agent` vì lý do lịch sử. Đây là một HTTP Gateway
> deterministic, **không phải AI agent**, không chạy model và không cần LLM.

## Có thực sự cần Gateway không?

Phần lớn dự án không cần.

| Nhu cầu | Đường đơn giản nhất |
|---|---|
| Producer và worker đều viết bằng Go | embedded `*rhinoq.Client` |
| Service khác ngôn ngữ chỉ cần tạo job | `rhinoq.enqueue()` trong transaction SQL |
| CLI, migration, doctor, Rule scheduler | CLI kết nối PostgreSQL trực tiếp |
| Worker không phải Go cần claim/heartbeat/effect | HTTP Gateway |

Chỉ thêm Gateway ở dòng cuối. Nó tạo thêm một process, token, health probes và
deployment lifecycle cần vận hành.

## Vì sao Gateway vẫn tồn tại?

Lease, fencing, retry classification, Effect Ledger và recovery là correctness
logic. Nếu mỗi SDK Node, Python, Java tự triển khai lại, semantics có thể lệch
giữa các ngôn ngữ. Gateway giữ logic đó trong Go; client chỉ gửi intent,
observation và operator decision.

```text
Node / Python / Java worker
            │ thin HTTP client
            ▼
Optional RhinoQ HTTP Gateway
            │ database/sql
            ▼
        PostgreSQL
```

TypeScript client tham chiếu nằm ở
[`sdks/typescript/src/interfaces/sdk/agent-client.ts`](../sdks/typescript/src/interfaces/sdk/agent-client.ts).

## Khi chỉ cần transactional enqueue

Migration `003_sql_enqueue.sql` tạo hàm `rhinoq.enqueue()`. Producer role phải
được allowlist trước:

```sql
INSERT INTO rhinoq.job_allowlist (
    job_name,
    producer_role,
    max_payload_bytes
) VALUES (
    'generate-report',
    'app_report_producer',
    262144
);
```

Sau đó application có thể ghi business record và job trong cùng transaction:

```sql
BEGIN;

INSERT INTO reports (id, status)
VALUES ('report_01', 'queued');

SELECT rhinoq.enqueue(
    job_name        => 'generate-report',
    payload         => '{"reportId":"report_01"}'::jsonb,
    idempotency_key => 'report:report_01',
    correlation_id  => 'report_01'
);

COMMIT;
```

Function kiểm role, allowlist, payload size/schema, class, priority,
correlation và idempotency trước khi ghi. Không cấp một producer role chung
quyền enqueue mọi job name.

## Khởi động Gateway

Chuẩn bị schema bằng CLI trước, rồi đặt token:

```bash
export RHINOQ_DATABASE_URL='postgres://...'
export RHINOQ_AGENT_TOKEN='a-long-random-secret'

rhinoq migrate plan
rhinoq migrate apply
go run ./cmd/rhinoq-agent
```

Gateway từ chối khởi động nếu không có token, trừ khi operator chủ động đặt
`RHINOQ_AGENT_ALLOW_UNAUTHENTICATED=true`. Không dùng tùy chọn đó ngoài local
development.

## Handshake bắt buộc

Client thương lượng protocol/capability trước khi nhận việc:

```http
POST /v1/handshake
Content-Type: application/json
Authorization: Bearer <token>

{
  "protocolVersion": "1.0",
  "capabilities": ["claim", "heartbeat", "fencing", "cancel", "effect"],
  "payloadCodec": "json"
}
```

| Kết quả | Hành vi |
|---|---|
| `compatible` | đủ capability, có thể làm việc |
| `degraded` | thiếu capability không cốt lõi; client phải hiển thị lý do |
| `rejected` | sai major hoặc thiếu claim/heartbeat/fencing; trả `426` |

## Worker lifecycle

```text
POST /v1/claim
    → lease token {jobId, owner, epoch}
POST /v1/leases/heartbeat
    → renew lease + observe cancellation
POST /v1/leases/complete
    → terminal success
POST /v1/leases/fail
    → classified failure
```

Mọi write sau claim phải gửi đúng owner/epoch. `409 RHINOQ_LEASE_LOST` nghĩa là
execution đã stale: worker phải dừng effect và không retry write đó.

Error do SDK gửi lên là language-neutral:

```json
{
  "lease": {"jobId": "job_...", "owner": "python-worker-1", "epoch": 3},
  "queue": "provider-sync",
  "error": {
    "type": "ConnectionError",
    "retryClass": "dependency_down",
    "message": "connection refused",
    "language": "python"
  }
}
```

`retryClass` gồm `transient`, `permanent`, `rate_limited`,
`dependency_down`, `cancelled`, và `unknown`. Thiếu hoặc sai class được coi là
`unknown` và xử lý fail-closed theo policy; Gateway không đoán từ stack trace.

## Endpoint groups

| Nhóm | Endpoint chính |
|---|---|
| Protocol | `POST /v1/handshake` |
| Producer | `POST /v1/jobs`, `GET /v1/jobs`, cancel |
| Worker | claim, heartbeat, complete, fail, release |
| Effect | begin, resolve |
| Findings | observe, list, transition, history |
| Rules | register, list, explain, enable, disable, evaluate |
| Operator | queue counts/pause/resume, attention, replay, audit, attempts |
| Process | `/health/live`, `/health/ready`, `/metrics` |

`/health/live` không chạm database. `/health/ready` kiểm dependency và trả
`503` trong lúc drain. Không gộp hai probe, nếu không database chậm có thể tạo
restart loop.

## Giới hạn hiện tại

- Chưa có tenant isolation và HTTP-layer per-job-name RBAC.
- Chưa có gRPC/Unix socket, streaming claim hoặc compression.
- TypeScript là reference client duy nhất; chưa cam kết SDK Python/Java/.NET.
- HTTP Gateway không phải control plane và không thay thế database backup,
  restricted roles hay network policy.

Chỉ mở rộng Gateway/SDK khi có design partner thực sự cần polyglot worker.
