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

Trước khi chạy production:

1. Apply migrations trong `internal/infrastructure/migrations/` theo thứ tự số.
2. Kiểm tra `db.PingContext` qua readiness check.
3. Cấu hình connection pool và hard connection budget.
4. Chạy PostgreSQL integration/fault tests.

`NewInMemory()` chỉ dành cho local/demo/test; nó mất state khi process restart.

## Chi phí truy vấn cần biết

| Đường đi | Chi phí |
|---|---|
| Claim | một `SELECT ... FOR UPDATE SKIP LOCKED`, một reservation per queue trong batch, một `UPDATE` bulk và một append attempt-event batch. |
| Heartbeat | một statement: gia hạn lease, kiểm fence và đọc `cancel_requested` cùng lúc. |
| Enqueue vào queue có admission policy | thêm một count bị chặn ở đúng capacity, dùng partial index `rhinoq_jobs_pending_by_queue_idx`. Không count toàn bảng. |
| Reaper | một statement, `FOR UPDATE SKIP LOCKED`, đồng thời append lease-expired evidence và trả số job requeue/park. |

Aging trong `ORDER BY` không index được, nên index claim phủ phần filter (`state`, `not_before`, `priority`, `created_at`) và phần xếp hạng chạy trên tập candidate đã hẹp.

`tests/postgres` áp dụng migrations từ đầu và chạy contract/integrity tests trên PostgreSQL thật. Việc suite xanh là storage evidence, chưa thay thế benchmark, fault injection, restore test hoặc production capacity planning.
