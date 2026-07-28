# Bắt đầu với RhinoQ

RhinoQ mặc định chạy **embedded trong ứng dụng Go** và lưu state ở PostgreSQL.
Bạn không cần Agent, LLM, control plane hay một server RhinoQ riêng.

Nếu application dùng Node.js, xem [Node.js integration](./nodejs.md). Producer
Node có thể enqueue trực tiếp trong transaction PostgreSQL và không cần
Gateway; chỉ Node worker mới cần Gateway.

> RhinoQ đang ở active development. Hãy pin version trong `go.mod`, review
> migration và chỉ dùng ở môi trường kiểm soát cho tới khi có stable release.

## Yêu cầu

- Go 1.22+
- PostgreSQL 16 (phiên bản hiện được chạy trong CI; các phiên bản khác chưa
  được release-certify)
- driver `database/sql` cho PostgreSQL; ví dụ này dùng `pgx`
- CLI `rhinoq` để migrate, kiểm tra và vận hành

## 1. Cài library và CLI

```bash
go get github.com/rhinoq/rhinoq
go get github.com/jackc/pgx/v5
go install github.com/rhinoq/rhinoq/cmd/rhinoq@latest
```

Nếu đang phát triển ngay trong repository:

```bash
go run ./cmd/rhinoq version
```

## 2. Chuẩn bị database

```bash
export RHINOQ_DATABASE_URL='postgres://postgres:postgres@localhost:5432/app?sslmode=disable'
```

Luồng migration luôn explicit:

```bash
rhinoq migrate plan       # chỉ đọc, không sửa database
rhinoq migrate sql        # in SQL pending để DBA review
rhinoq migrate apply      # action ghi dữ liệu rõ ràng
rhinoq doctor --ci        # kiểm config, kết nối và schema
```

Runner kiểm checksum của migration đã apply, lấy advisory lock và commit từng
migration trong một transaction. Nếu database có bảng RhinoQ cũ nhưng chưa có
metadata migration, CLI dừng lại để operator baseline thủ công; nó không đoán
schema.

## 3. Tạo durable client

```go
package jobs

import (
    "context"
    "database/sql"
    "os"

    _ "github.com/jackc/pgx/v5/stdlib"
    "github.com/rhinoq/rhinoq/pkg/rhinoq"
)

func Open(ctx context.Context) (*rhinoq.Client, *sql.DB, error) {
    db, err := sql.Open("pgx", os.Getenv("RHINOQ_DATABASE_URL"))
    if err != nil {
        return nil, nil, err
    }
    if err := db.PingContext(ctx); err != nil {
        _ = db.Close()
        return nil, nil, err
    }
    queue, err := rhinoq.NewPostgres(db)
    if err != nil {
        _ = db.Close()
        return nil, nil, err
    }
    return queue, db, nil
}
```

Application sở hữu `*sql.DB`, nên phải đặt `MaxOpenConns`, `MaxIdleConns` và
connection lifetime theo budget chung của hệ thống.

## 4. Đăng ký handler và enqueue

```go
if err := queue.Handle("generate-report", func(ctx context.Context, job rhinoq.Job) error {
    return reports.Generate(ctx, job.Payload)
}); err != nil {
    return err
}

jobID, err := queue.Enqueue(ctx, rhinoq.JobRequest{
    Name:           "generate-report",
    Payload:        payload,
    IdempotencyKey: "report:" + reportID,
    CorrelationID:  reportID,
    Priority:       10,
    Class:          rhinoq.ClassInteractive,
})
if err != nil {
    return err
}
```

`IdempotencyKey` được scope theo job name. `CorrelationID` liên kết execution
với business subject và nên được đặt ngay từ đầu.

## 5. Chạy worker

```go
if err := queue.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
    return err
}
```

Khi context bị hủy, worker ngừng claim, drain handler theo grace period và
không release lease của handler vẫn còn chạy. Worker khác chỉ được nhận lại job
sau khi lease hết hạn.

## 6. Thêm Rule xác minh business state

Rule table nhận:

- `$1`: baseline timestamp;
- `$2`: cursor `subject_id` cuối cùng;
- `$3`: hard row limit.

Và phải trả đúng ba cột:

```text
subject_id text | violated boolean | evidence jsonb/text
```

```go
record, err := queue.RegisterRule(ctx, rhinoq.RuleDefinition{
    ID:          "ready-report-has-output",
    Name:        "Ready reports have an output object",
    Scope:       rhinoq.RuleScopeTable,
    SubjectType: "report",
    Query: `
        SELECT id::text AS subject_id,
               output_key IS NULL AS violated,
               jsonb_build_object('status', status) AS evidence
        FROM reports
        WHERE created_at >= $1 AND id::text > $2
        ORDER BY id::text
        LIMIT $3`,
    BaselineAt: time.Now().Add(-24 * time.Hour),
    Every:      10 * time.Minute,
    MaxRows:    250,
})
if err != nil {
    return err
}

_, explanation, err := queue.EnableRule(ctx, record.ID)
if err != nil {
    return fmt.Errorf("Rule unsafe: %w (%v)", err, explanation.Reasons)
}
```

Enable chỉ thành công sau PostgreSQL Explain gate. Chạy scheduler embedded:

```go
go queue.RunRuleScheduler(ctx, rhinoq.RuleSchedulerConfig{
    Owner:        "integrity-1",
    PollInterval: time.Second,
    Lease:        time.Minute,
    ClaimBatch:   4,
})
```

Hoặc giữ scheduler thành process thủ công:

```bash
rhinoq rules run --owner integrity-1
```

Không có auto-tuning ngầm. Developer review telemetry rồi mới thay config/flag.

## 7. Kiểm soát vận hành

```bash
rhinoq jobs list --queue generate-report --states pending,blocked,dead
rhinoq queue counts generate-report
rhinoq queue pause generate-report
rhinoq queue resume generate-report
rhinoq attention
rhinoq findings list
rhinoq rules list
rhinoq explain ready-report-has-output
```

Các list command không trả payload mặc định. `attention` gộp lỗi execution,
effect uncertain, outcome mismatch và Finding đang sống.

## Hai đường tích hợp khác

- Chỉ cần enqueue từ service khác ngôn ngữ: dùng hàm SQL
  `rhinoq.enqueue()` ngay trong transaction nghiệp vụ.
- Cần worker không phải Go: cân nhắc HTTP Gateway tùy chọn trong
  [agent.md](./agent.md). Gateway không dùng AI/LLM.

Không đưa Gateway vào deployment chỉ để gọi CLI hoặc chạy Rule scheduler.

## Local test

Memory adapter dành cho test/demo:

```go
queue := rhinoq.NewInMemory()
```

Nó không durable. Để chạy PostgreSQL suite của repository:

```bash
docker compose -f tests/postgres/docker-compose.yml up -d --wait
cd tests/postgres
RHINOQ_TEST_DATABASE_URL='postgres://rhinoq:rhinoq@localhost:55432/rhinoq?sslmode=disable' go test ./... -count=1
```

## Khi setup lỗi

| Triệu chứng | Kiểm tra |
|---|---|
| `RHINOQ_DATABASE_URL is empty` | export đúng URL cho process CLI/application |
| `migration state` fail | chạy `rhinoq migrate plan`; không sửa migration đã apply |
| `untracked schema` | dừng auto-apply, review/baseline database thủ công |
| Rule không enable | chạy `rhinoq explain <id>` và sửa shape/index/query budget |
| job không được claim | kiểm pause, rate limit, `not_before`, admission và handler name |

Tiếp theo: [PostgreSQL](./postgres.md), [Operations](./operations.md),
[Integrity Rules](./rules.md), và [Failure semantics](./failure-semantics.md).
