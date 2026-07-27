# Getting started

RhinoQ hiện đang ở giai đoạn private development. Quickstart này chạy các core primitive bằng Go và memory adapter; nó không đại diện cho production deployment.

## Yêu cầu

- Go 1.22+
- PostgreSQL chỉ cần khi chạy persistence integration

## Kiểm tra repository

```bash
make check
```

Hoặc chạy riêng:

```bash
gofmt -w cmd internal tests
go test ./...
go vet ./...
```

## CLI

```bash
go run ./cmd/rhinoq-cli doctor
go run ./cmd/rhinoq-cli doctor --ci
go run ./cmd/rhinoq-cli init
go run ./cmd/rhinoq-cli init --apply
```

`init` mặc định chỉ tạo plan và không sửa file. `--apply` mới tạo `rhinoq.config.env.example`. `doctor --ci` trả exit code khác 0 nếu có mục FAIL.

## Enqueue

```go
id, err := queue.Enqueue(ctx, rhinoq.JobRequest{
    Name:           "generate-report",
    Payload:        payload,
    IdempotencyKey: "report:report_01",
    CorrelationID:  "report_01",
    Priority:       10,                    // -100..100, job chờ lâu được tăng dần
    Class:          rhinoq.ClassCritical,  // dùng được phần budget reserved
    RunAfter:       0,                     // > 0 để delay
})
```

`JobRequest` là API duy nhất để enqueue; không có hệ cấu hình song song.

## Luồng core

```text
enqueue → admission → claim (priority + FIFO + aging)
       → lease (owner + epoch) → heartbeat → handler
       → complete / retry / dead / blocked
       → effect confirmation → outcome verification
```

Mọi write sau claim phải trình đúng `(lease_owner, lease_epoch)`. Handler nhận `ErrLeaseLost` nghĩa là job đã thuộc execution khác và phải dừng ngay.

## Giới hạn hiện tại

Các command entrypoint mới là bootstrap. PostgreSQL adapter và runtime package đã có boundary/test, nhưng wiring production và protocol code generation chưa hoàn thiện.
