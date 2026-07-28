# PostgreSQL production client

Public API dùng chung cho memory và PostgreSQL:

```go
db, err := sql.Open("pgx", os.Getenv("RHINOQ_DATABASE_URL"))
if err != nil { return err }
defer db.Close()

queue, err := rhinoq.NewPostgres(db)
if err != nil { return err }
```

Driver PostgreSQL và cách `sql.Open` thuộc application của người dùng; RhinoQ chỉ nhận `*sql.DB` và không khóa driver dependency ở core.

CLI chính thức bundle driver `pgx`; thư viện core vẫn nhận `*sql.DB` để
application tự sở hữu pool và driver. Chuẩn bị schema bằng luồng explicit:

```bash
export RHINOQ_DATABASE_URL=postgres://...
rhinoq migrate plan      # read-only
rhinoq migrate status    # read-only
rhinoq migrate sql       # SQL pending để DBA review
rhinoq migrate apply     # write explicit
rhinoq doctor --ci
```

Migration runner embed đúng SQL đã phát hành, kiểm SHA-256 checksum, khóa bằng
PostgreSQL advisory lock và commit từng migration trong một transaction.
RhinoQ fail-closed nếu phát hiện bảng RhinoQ cũ nhưng không có metadata
migration: operator phải review/baseline thủ công, không tự suy đoán schema.

Trước khi chạy production:

1. Review rồi apply migration bằng CLI.
2. Kiểm tra `db.PingContext` qua readiness check.
3. Cấu hình connection pool và hard connection budget.
4. Chạy PostgreSQL integration/fault tests.

`NewInMemory()` chỉ dành cho local/demo/test; nó mất state khi process restart.

## Quyền tối thiểu cho SQL/Node producer

`rhinoq.enqueue()` là `SECURITY DEFINER`: producer được tạo job qua một
function đã validate mà không có quyền ghi trực tiếp vào bảng queue. Migration
008 thu hồi `EXECUTE` của `PUBLIC`; DBA cấp đúng hai quyền cho producer role:

```sql
GRANT USAGE ON SCHEMA rhinoq TO app_report_producer;
GRANT EXECUTE ON FUNCTION rhinoq.enqueue(
    text, jsonb, text, text, integer, text, interval, text
) TO app_report_producer;
```

Sau đó đăng ký từng job name:

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

Application login phải là role đó hoặc được grant membership có chủ đích.
Function kiểm `session_user`—login gọi hàm—thay vì `current_user`, vì bên trong
`SECURITY DEFINER`, `current_user` là owner của function. Không grant
`INSERT`/`UPDATE` trực tiếp trên `rhinoq_jobs` cho producer.

## Chi phí truy vấn cần biết

| Đường đi | Chi phí |
|---|---|
| Claim | một `SELECT ... FOR UPDATE SKIP LOCKED`, một reservation per queue trong batch, một `UPDATE` bulk và một append attempt-event batch. |
| Heartbeat | một statement: gia hạn lease, kiểm fence và đọc `cancel_requested` cùng lúc. |
| Enqueue vào queue có admission policy | thêm một count bị chặn ở đúng capacity, dùng partial index `rhinoq_jobs_pending_by_queue_idx`. Không count toàn bảng. |
| Reaper | một statement, `FOR UPDATE SKIP LOCKED`, đồng thời append lease-expired evidence và trả số job requeue/park. |
| Finding observation | transaction-scoped advisory lock theo finding key, fold observation vào current record và append lifecycle event trong cùng transaction. |
| Rule Explain/evaluate | read-only transaction, local statement timeout, hard row limit; Explain evidence lưu theo immutable Rule version. |

Aging trong `ORDER BY` không index được, nên index claim phủ phần filter (`state`, `not_before`, `priority`, `created_at`) và phần xếp hạng chạy trên tập candidate đã hẹp.

`tests/postgres` áp dụng migrations từ đầu và chạy contract/integrity tests trên PostgreSQL thật. Việc suite xanh là storage evidence, chưa thay thế benchmark, fault injection, restore test hoặc production capacity planning.
