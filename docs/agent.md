# Agent và tích hợp đa ngôn ngữ

## Câu hỏi: nhiều ngôn ngữ thì cần bao nhiêu code?

Một file mỏng cho mỗi ngôn ngữ. Không hơn.

```text
Application (Node · Python · Java · .NET · Go)
      │  thin client: enqueue · claim · report · effect
      ▼  HTTP
RhinoQ Agent    ← toàn bộ correctness
      │
      ▼
PostgreSQL
```

Lý do không viết lại logic ở mỗi SDK: nếu SDK Node xử lý lease một kiểu, SDK Python một kiểu khác, thì correctness bị nhân theo số ngôn ngữ. Một bug lease sẽ tồn tại ở năm nơi và được sửa ở một nơi.

**Agent giữ:** claim · ordering · lease · fencing · retry classification · rate limit · admission · effect ledger · finding lifecycle · recovery.
**Client chỉ gửi intent/observation/decision:** enqueue · nhận job · báo kết quả · ghi effect · ghi/triage finding.

Client TypeScript tham chiếu nằm ở [`sdks/typescript/src/interfaces/sdk/agent-client.ts`](../sdks/typescript/src/interfaces/sdk/agent-client.ts) — khoảng 200 dòng, không dependency. Port sang ngôn ngữ khác là dịch lại 200 dòng đó, không phải viết lại một queue.

## Hai đường vào, chọn theo nhu cầu

| Đường | Cần gì | Được gì | Dùng khi |
|---|---|---|---|
| `rhinoq.enqueue()` SQL function | không cần SDK, chỉ cần ORM sẵn có | enqueue trong đúng transaction nghiệp vụ, không dual-write | chỉ cần *tạo* job từ ngôn ngữ đó |
| Agent HTTP | một file client | đủ vòng đời: claim, heartbeat, complete/fail, effect | cần *chạy* job bằng ngôn ngữ đó |

Rất nhiều hệ thống chỉ cần đường thứ nhất cho hầu hết service, và đường thứ hai cho một hai service thật sự xử lý job.

## Đường 1 — SQL enqueue, không cần SDK

Migration `003_sql_enqueue.sql` tạo `rhinoq.enqueue()`. Đăng ký job name trước (allowlist là ranh giới quyền):

```sql
INSERT INTO rhinoq.job_allowlist (job_name, producer_role, max_payload_bytes)
VALUES ('settle-scan-credit', 'rhinoq_producer_payments', 262144);
```

Rồi enqueue từ bất kỳ ngôn ngữ nào, trong cùng transaction với business write:

```sql
BEGIN;
INSERT INTO scans (id, status) VALUES ('SCAN-9218', 'completed');
SELECT rhinoq.enqueue(
    job_name        => 'settle-scan-credit',
    payload         => '{"scanId":"SCAN-9218"}'::jsonb,
    idempotency_key => 'scan:SCAN-9218',
    correlation_id  => 'SCAN-9218');
COMMIT;
```

Function kiểm trước khi ghi: job name có trong allowlist · role được phép enqueue job đó · payload không null và không vượt giới hạn · payload schema khớp · correlation hợp lệ · class hợp lệ · priority trong khoảng. Payload quá lớn bị từ chối **ngay trong function**, không lọt vào bảng.

Không mở `rhinoq.enqueue(any_name, any_json)` cho một producer role chung: một service bị chiếm quyền sẽ tạo được job của mọi domain khác.

## Đường 2 — Agent HTTP

```bash
export RHINOQ_AGENT_TOKEN=$(openssl rand -hex 32)
export RHINOQ_DATABASE_URL=postgres://...
go run ./cmd/rhinoq-agent
```

Agent từ chối khởi động nếu không có token và cũng không có `RHINOQ_AGENT_ALLOW_UNAUTHENTICATED=true`.

### Handshake trước, làm việc sau

```http
POST /v1/handshake
{"protocolVersion":"1.0","capabilities":["claim","heartbeat","fencing","cancel","effect"],"payloadCodec":"json"}
```

Ba kết quả, phân biệt rõ:

| Kết quả | Nghĩa | Hành vi |
|---|---|---|
| `compatible` | đủ capability | chạy bình thường |
| `degraded` | thiếu capability không cốt lõi | vẫn chạy, `disabled` và `reason` nói rõ cái gì bị tắt |
| `rejected` | thiếu capability cốt lõi (`claim`, `heartbeat`, `fencing`) hoặc sai protocol major | trả `426`, từ chối kết nối |

`degraded` phải được log và hiển thị: một worker chạy thiếu tính năng hành xử khác một worker bình thường.

### Endpoint

| Nhóm | Endpoint |
|---|---|
| Producer | `POST /v1/jobs` · `GET /v1/jobs` · `POST /v1/jobs/{id}/cancel` |
| Worker | `POST /v1/claim` · `POST /v1/leases/heartbeat` · `POST /v1/leases/complete` · `POST /v1/leases/fail` · `POST /v1/leases/release` |
| Effect | `POST /v1/effects/begin` · `POST /v1/effects/resolve` |
| Findings | `POST /v1/findings/observe` · `GET /v1/findings` · `POST /v1/findings/transition` · `GET /v1/findings/history` |
| Rules | `POST /v1/rules` · `GET /v1/rules` · `POST /v1/rules/{id}/explain` · `POST /v1/rules/{id}/enable` · `POST /v1/rules/{id}/disable` · `POST /v1/rules/{id}/evaluate` |
| Operator | `GET /v1/queues/{name}/counts` · `POST /v1/queues/{name}/pause` · `POST /v1/queues/{name}/resume` · `GET /v1/attention` · `POST /v1/jobs/{id}/replay` · `GET /v1/jobs/{id}/audit` · `GET /v1/jobs/{id}/attempts` |
| Vận hành | `GET /health/live` · `GET /health/ready` · `GET /metrics` |

### Vòng đời một job qua HTTP

```text
POST /v1/claim              → nhận job + lease token {jobId, owner, epoch}
POST /v1/leases/heartbeat   → gia hạn lease, biết luôn job có bị cancel không
POST /v1/leases/complete    → xong
POST /v1/leases/fail        → hỏng, kèm error envelope
```

Lease token phải gửi kèm mọi thao tác sau đó. Sai `epoch` → `409 RHINOQ_LEASE_LOST`, và client phải **dừng**, không retry: job đã thuộc execution khác.

### Error envelope — hợp đồng xuyên ngôn ngữ

Client dịch exception bản địa thành envelope; Agent không parse stack trace theo ngôn ngữ:

```json
{
  "lease": {"jobId": "job_...", "owner": "python-worker-1", "epoch": 3},
  "queue": "settle-scan-credit",
  "error": {
    "type": "ConnectionError",
    "retryClass": "dependency_down",
    "message": "connection refused to provider-a",
    "language": "python"
  }
}
```

`retryClass` là thứ quyết định số phận job: `transient` · `permanent` · `rate_limited` · `dependency_down` · `cancelled` · `unknown`. Thiếu hoặc sai → `unknown`, tức retry thận trọng rồi park, **không bao giờ retry mù**.

Agent trả lại `fingerprint` để cùng một lỗi ở hai ngôn ngữ gom về một nhóm. Hiện dùng SHA-256, không phải BLAKE3.

### Lỗi trả về

Mọi lỗi có một dạng duy nhất:

```json
{"error": {"code": "RHINOQ_QUEUE_OVER_CAPACITY", "message": "...", "retryable": true, "retryAfterMs": 30000}}
```

| Status | Nghĩa |
|---|---|
| `401` | thiếu hoặc sai token |
| `409` | fencing từ chối, hoặc effect uncertain/đã confirmed |
| `422` | replay bị từ chối vì effect chưa an toàn |
| `426` | protocol không tương thích |
| `429` | queue vượt ngân sách admission, kèm `retryAfterMs` |

`message` mang đủ năm phần: chuyện gì đã xảy ra · vì sao quan trọng · RhinoQ đã làm gì · sửa thế nào · kiểm lại bằng lệnh nào.

## Health và metrics

`/health/live` chỉ trả lời process còn sống — không chạm database. `/health/ready` kiểm store thật và trả `503` khi Agent đang drain. Gộp hai cái làm một sẽ tạo restart loop mỗi khi database chậm.

`/metrics` xuất Prometheus text format, không kéo thêm dependency:

```text
rhinoq_jobs{state="pending"} 42
rhinoq_agent_jobs_accepted_total 1200
rhinoq_agent_jobs_failed_total 3
rhinoq_agent_ready 1
```

## Thứ tự triển khai SDK

1. TypeScript client (đã có, tham chiếu)
2. Protocol ổn định
3. Go SDK
4. Python SDK
5. Java/.NET nếu có nhu cầu thật

Không thêm SDK thứ hai nếu chưa có người cam kết maintain: chi phí tăng theo *số ngôn ngữ*, không theo số tính năng.

## Chưa có

gRPC/Unix socket transport · msgpack/zstd · streaming claim (long-poll) · tenant isolation · per-job-name RBAC ở tầng HTTP (mới có ở SQL function) · Agent chạy embedded trong process ứng dụng.
