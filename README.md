# RhinoQ

RhinoQ là một job queue durable đang được phát triển theo mô hình Go engine + TypeScript SDK. Repository này hiện là private development repository; API và schema chưa được xem là stable.

## Trạng thái hiện tại

Đã có scaffold và implementation nền cho:

- job enqueue với idempotency
- job state machine
- claim/lease/renew/complete
- worker handler registry và bounded concurrency
- heartbeat, lease reaper và graceful shutdown
- retry classification
- Effect Ledger
- Outcome verification
- PostgreSQL Job/Effect/Outcome/Outbox adapters
- outbox publisher
- unit/integration tests

Chưa hoàn thiện:

- PostgreSQL integration test chạy trên database thật
- protocol code generation và Agent transport
- CLI/Console đầy đủ
- provider adapters
- metrics/tracing production
- benchmark suite và fault-test evidence

Không sử dụng các số liệu throughput/latency từ repository này như production claim khi chưa có benchmark tái lập.

## Kiến trúc

```text
Go engine
├── internal/domain          state machines và invariant
├── internal/application     use cases
├── internal/ports           interfaces
├── internal/adapters        memory/PostgreSQL/external systems
├── internal/runtime         worker/lease/scheduler/shutdown
└── internal/infrastructure  migrations/bootstrap

TypeScript SDK
└── sdks/typescript          client và developer-facing API

Protocol
└── proto/rhinoq/v1           versioned transport contract
```

Quy tắc dependency: Domain không biết database/framework; Application gọi qua Ports; Adapter implement Ports; SDK không chứa correctness logic của lease, retry hoặc Effect Ledger.

Chi tiết nằm trong [ARCHITECTURE.md](./ARCHITECTURE.md).

## Yêu cầu phát triển

- Go 1.22+
- Node.js 22+ cho TypeScript SDK
- PostgreSQL cho persistence integration

## Kiểm tra local

```bash
gofmt -w cmd internal tests
go test ./...
go vet ./...
```

## Quickstart chạy được

Chạy ví dụ local với memory adapter:

```bash
go run ./examples/basic
```

Hoặc dùng public Go API:

```go
queue := rhinoq.NewInMemory()
queue.Handle("send-welcome", func(ctx context.Context, job rhinoq.Job) error {
    return sendWelcomeEmail(ctx, job.Payload)
})
queue.Enqueue(ctx, "send-welcome", payload, "welcome:user-1")
queue.Run(ctx)
```

Quickstart này chỉ dành cho local development. Production sẽ dùng PostgreSQL adapter và protocol/Agent; memory adapter không cung cấp durability sau process restart.

Kiểm tra TypeScript SDK:

```bash
npm --prefix sdks/typescript install
npm --prefix sdks/typescript run typecheck
```

CI chạy các kiểm tra Go, TypeScript, CodeQL và dependency review. Xem [.github/workflows](./.github/workflows).

## Cấu trúc repository

| Path | Nội dung |
|---|---|
| `cmd/` | binary entrypoints của Agent, Worker và CLI |
| `internal/domain/` | domain state và invariant |
| `internal/application/` | use cases |
| `internal/ports/` | interfaces của core |
| `internal/adapters/` | memory và PostgreSQL implementations |
| `internal/runtime/` | worker, lease, scheduler, supervisor |
| `internal/infrastructure/migrations/` | SQL migrations |
| `proto/` | protocol versioning |
| `sdks/typescript/` | Node.js/TypeScript SDK |
| `tests/` | unit, integration, fault, benchmark gates |
| `.ai/` | project memory và AI workflow |

## Quy trình thay đổi

Đọc [AGENTS.md](./AGENTS.md) trước khi sửa code. Mọi thay đổi nên đi theo:

```text
inspect → plan → implement → test → review diff → update docs/changelog
```

Pull request phải tuân theo [CONTRIBUTING.md](./CONTRIBUTING.md). Release dùng [.ai/RELEASE_CHECKLIST.md](./.ai/RELEASE_CHECKLIST.md).

## Persistence

Migration đầu tiên nằm ở [internal/infrastructure/migrations/001_initial.sql](./internal/infrastructure/migrations/001_initial.sql). PostgreSQL là authoritative store mặc định; memory adapter chỉ dùng cho unit/integration test không cần database.

## Open-core plan

Repository hiện chưa public và chưa gắn license open-source. Khi engine ổn định, license và phạm vi public package sẽ được chốt riêng bằng ADR. Xem [LICENSE-STRATEGY.md](./LICENSE-STRATEGY.md).

## Tài liệu

- [ARCHITECTURE.md](./ARCHITECTURE.md) — blueprint kỹ thuật
- [RHINOQ.md](./RHINOQ.md) — product/architecture specification
- [docs/](./docs/) — getting started, operations, failure semantics và feature matrix
- [SECURITY.md](./SECURITY.md) — security policy
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) — quy tắc cộng tác
- [GOVERNANCE.md](./GOVERNANCE.md) — quyền merge và lộ trình open-core
- [CHANGELOG.md](./CHANGELOG.md) — lịch sử thay đổi
