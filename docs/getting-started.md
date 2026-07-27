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
go run ./cmd/rhinoq-cli init
go run ./cmd/rhinoq-cli init --apply
```

`init` mặc định chỉ tạo plan và không sửa file. `--apply` mới tạo `rhinoq.config.env.example`.

## Luồng core

```text
enqueue → claim → lease → heartbeat → handler
       → complete / retry / dead / blocked
       → effect confirmation → outcome verification
```

## Giới hạn hiện tại

Các command entrypoint mới là bootstrap. PostgreSQL adapter và runtime package đã có boundary/test, nhưng wiring production và protocol code generation chưa hoàn thiện.
