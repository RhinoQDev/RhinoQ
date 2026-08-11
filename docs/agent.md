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
| Node app chỉ cần Task layer cho queue sẵn có | `PostgresTaskClient` + Task-only schema |
| Worker không phải Go cần claim/heartbeat/effect | HTTP Gateway |

Chỉ thêm Gateway ở dòng cuối. Nó tạo thêm một process, token, health probes và
deployment lifecycle cần vận hành.

Task-only Node path tạo đúng ba bảng trong `rhinoq_task` bằng `npx rhinoq-task`
và dùng pool sẵn có của application. Nó không áp migrations 001–017, không cần
Go toolchain và không dùng operator/owner token.

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

Node.js SDK tham chiếu nằm ở [`sdks/node`](../sdks/node). SDK gồm
`PostgresProducer` cho đường không cần Gateway, `RhinoQClient` cho wire API và
`RhinoQWorker` cho vòng đời claim/heartbeat/shutdown.

## Task API polling-first

Gateway hiện có các endpoint Task/Execution sau đi qua public facade và
Application:

| Endpoint | Ý nghĩa |
|---|---|
| `POST /v1/tasks` | tạo Task và trả Snapshot v1 |
| `GET /v1/tasks/{id}` | đọc Snapshot mới nhất để BE/FE polling |
| `POST /v1/tasks/{id}/state` | lifecycle command với `expectedVersion` |
| `POST /v1/tasks/{id}/cancel` | owner/operator yêu cầu hủy an toàn |
| `POST /v1/tasks/{id}/cancellation` | runtime ghi outcome hủy |
| `POST /v1/tasks/{id}/progress` | progress command với `expectedVersion` |
| `POST /v1/tasks/{id}/result` | ghi result reference với `expectedVersion` |
| `GET /v1/tasks/{id}/result` | đọc result reference riêng khỏi Snapshot |
| `GET /v1/tasks/{id}/execution-results` | đọc result reference theo từng attempt |
| `POST /v1/tasks/{id}/executions` | tạo attempt cho native/external runtime |
| `GET /v1/task-executions/lookup` | tìm Execution bằng runtime/external ID |
| `GET /v1/task-executions/{id}` | đọc Execution cho adapter/operator |
| `POST /v1/task-executions/{id}/bind` | bind một lần tới `jobId` hoặc `externalId` |
| `POST /v1/task-executions/{id}/state` | ghi lifecycle/failure reason của attempt |
| `POST /v1/task-executions/{id}/result` | ghi result reference của attempt |

Snapshot có `schemaVersion` cho wire compatibility và aggregate
`entityVersion` tăng theo Task mutation lẫn create/bind Execution. Client phải
giữ version cao nhất đã thấy và bỏ response cũ. Một write dùng version stale
trả `409 RHINOQ_VERSION_CONFLICT`; caller phải đọc lại trước khi quyết định
command tiếp theo.

Đây chưa phải realtime API. Không có SSE/WebSocket và Gateway không proxy result
payload. `hasResult` chỉ báo availability; endpoint result trả storage
reference. Gateway có credential owner-scoped cho Task read/result/cancel,
nhưng chưa có organization membership/RBAC hay auth model đa tenant hoàn
chỉnh, nên không đưa endpoint này ra public Internet.

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
    current_user,
    262144
);
```

`current_user` giúp ví dụ local cho phép đúng login vừa chạy migration. Ở
production, thay nó bằng login service có quyền tối thiểu hoặc producer role
được grant có chủ đích. Migration mới nhất kiểm danh tính login gọi hàm, không
kiểm role của chủ sở hữu `SECURITY DEFINER`.

Nếu migration do DBA/owner khác chạy, cấp đúng function boundary cho producer:

```sql
GRANT USAGE ON SCHEMA rhinoq TO app_report_producer;
GRANT EXECUTE ON FUNCTION rhinoq.enqueue(
    text, jsonb, text, text, integer, text, interval, text, text
) TO app_report_producer;
```

Không grant quyền ghi trực tiếp vào `rhinoq_jobs`. Migration 008 đã thu hồi
quyền `EXECUTE` mặc định của `PUBLIC`.

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

Binary chính thức đã đăng ký sẵn driver `pgx`. Archive tagged được phát hành
gồm cả `rhinoq` và `rhinoq-agent`; beta.11 là bản tagged đã được xác minh gần
nhất, đã publish npm package, GitHub Release, binary và container. Chuẩn
bị schema bằng CLI trước, rồi đặt token:

```bash
export RHINOQ_DATABASE_URL='postgres://...'
export RHINOQ_AGENT_TOKEN="$(openssl rand -hex 32)"

rhinoq migrate plan
rhinoq migrate apply
go run ./cmd/rhinoq-agent
```

PowerShell:

```powershell
$env:RHINOQ_DATABASE_URL = 'postgres://...'
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$env:RHINOQ_AGENT_TOKEN = [Convert]::ToBase64String($bytes)

go run ./cmd/rhinoq migrate plan
go run ./cmd/rhinoq migrate apply
go run ./cmd/rhinoq-agent
```

Ý nghĩa từng process:

| Command | Chức năng | Có chạy lâu dài |
|---|---|:---:|
| `rhinoq migrate plan` | kiểm migration/checksum, không ghi database | Không |
| `rhinoq migrate apply` | apply schema đã review | Không |
| `go run ./cmd/rhinoq-agent` | chạy HTTP Gateway tại `127.0.0.1:8080` mặc định | Có |
| `node worker.mjs` | chạy handler của ứng dụng Node | Có |

Gateway từ chối khởi động nếu không có token, trừ khi operator chủ động đặt
`RHINOQ_AGENT_ALLOW_UNAUTHENTICATED=true`. Không dùng tùy chọn đó ngoài local
development. Token phải dài ít nhất 32 byte. Chế độ unauthenticated bị từ chối
nếu `RHINOQ_AGENT_ADDRESS` không phải loopback.

Các biến cấu hình Gateway:

| Biến | Mặc định | Ý nghĩa |
|---|---:|---|
| `RHINOQ_DATABASE_URL` | memory store | PostgreSQL durable store; để trống chỉ dành cho demo |
| `RHINOQ_DATABASE_DRIVER` | `pgx` | tên driver `database/sql`; custom driver cần custom build |
| `RHINOQ_AGENT_ADDRESS` | `127.0.0.1:8080` | địa chỉ HTTP lắng nghe |
| `RHINOQ_AGENT_TOKEN` | empty | bearer token tối thiểu 32 byte cho mọi endpoint được bảo vệ |
| `RHINOQ_AGENT_ALLOW_UNAUTHENTICATED` | false | cho phép không token, chỉ dành cho local development |
| `RHINOQ_AGENT_HEARTBEAT` | `10s` | heartbeat interval trả cho SDK khi handshake |
| `RHINOQ_AGENT_SHUTDOWN_GRACE` | `20s` | thời gian drain HTTP khi dừng |
| `RHINOQ_MAX_PAYLOAD_BYTES` | `1048576` | hard limit request body/payload |
| `RHINOQ_AGENT_REQUESTS_PER_SECOND` | `200` | per-process protected-route token-bucket rate |
| `RHINOQ_AGENT_REQUEST_BURST` | `400` | per-process burst allowance |
| `RHINOQ_REPAIR_CALLBACKS_JSON` | empty | deployment-allowlisted signed business repair callbacks |

Gateway không tự terminate TLS. Nếu bind ra non-loopback, đặt nó sau HTTPS
reverse proxy/service mesh và network policy; không expose cổng HTTP trực tiếp.
Bearer token hiện là deployment credential chung, chưa phải end-user token.

Kiểm tra readiness:

```bash
curl -H "Authorization: Bearer $RHINOQ_AGENT_TOKEN" \
  http://127.0.0.1:8080/health/ready
```

## Handshake bắt buộc

Client thương lượng protocol/capability trước khi nhận việc:

```http
POST /v1/handshake
Content-Type: application/json
Authorization: Bearer <token>

{
  "protocolVersion": "1.0",
  "capabilities": [
    "claim",
    "heartbeat",
    "fencing",
    "cancel",
    "effect",
    "batch-claim",
    "queue-filter"
  ],
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
    → queues=[các handler đã đăng ký]
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

Gateway lọc `queues` trước khi PostgreSQL khóa candidate. Một worker Node chỉ
đăng ký `generate-report` không được claim `send-email`. SDK vẫn kiểm tra lần
hai và release job lạ thay vì chạy nhầm handler.

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
| Effect | begin, resolve, external confirmation |
| Findings | observe, list, transition, history |
| Rules | register, list, explain, enable, disable, evaluate |
| Operator | queue counts/pause/resume, attention, replay, audit, attempts |
| Process | `/health/live`, `/health/ready`, `/metrics` |

`/health/live` không chạm database. `/health/ready` kiểm dependency và trả
`503` trong lúc drain. Không gộp hai probe, nếu không database chậm có thể tạo
restart loop.

## Giới hạn hiện tại

- Chưa có tenant isolation và HTTP-layer per-job-name RBAC.
- Chưa có TLS termination, distributed edge rate limit, token rotation hoặc
  failed-auth audit. Gateway chỉ có limiter theo từng process; xem
  [security audit](./security-audit-2026-07-29.md).
- Chưa có gRPC/Unix socket, streaming claim hoặc compression.
- Node.js là SDK preview duy nhất; chưa cam kết SDK Python/Java/.NET.
- `beta.11` là public prerelease đã được xác minh gần nhất trên npm và GitHub
  Release; vẫn chỉ dùng cho evaluation và controlled pilots.
- HTTP Gateway không phải control plane và không thay thế database backup,
  restricted roles hay network policy.

Chỉ mở rộng Gateway/SDK khi có design partner thực sự cần polyglot worker.
