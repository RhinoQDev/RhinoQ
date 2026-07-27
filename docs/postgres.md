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

1. Apply migrations trong `internal/infrastructure/migrations/`.
2. Kiểm tra `db.PingContext` qua readiness check.
3. Cấu hình connection pool và hard connection budget.
4. Chạy PostgreSQL integration/fault tests.

`NewInMemory()` chỉ dành cho local/demo/test; nó mất state khi process restart.
