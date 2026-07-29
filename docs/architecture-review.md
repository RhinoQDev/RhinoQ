# Architecture and repository organization review

Reviewed: 2026-07-29

## Kết luận

RhinoQ đang có nền kiến trúc phù hợp để mở rộng ở giai đoạn hiện tại:
**Go modular monolith + ports/adapters + public facade + SDK mỏng**. Chưa có bằng
chứng nào biện minh cho việc tách microservice hoặc sao chép số lượng package
của các dự án đã trưởng thành nhiều năm.

Dependency direction sau audit:

```text
contracts (data/version/validation only)
              ↑
interfaces → public facade → application → domain
                              └──────────→ ports ← adapters
runtime ─────────────────────→ domain + ports
composition root ────────────→ adapters + application + runtime
```

`Domain` không phụ thuộc `Ports`. Contract không dựng DTO từ Domain; Application
làm anti-corruption mapping. `tests/unit/architecture_test.go` khóa các import
rule này để refactor sau không âm thầm đảo dependency.

## Đối chiếu repo lớn

| Repository | Pattern quan sát được | RhinoQ học gì | Không sao chép |
|---|---|---|---|
| [Temporal server](https://github.com/temporalio/temporal) | API/proto, schema, service, client và test có boundary riêng; tài liệu mô tả Frontend/History/Matching theo trách nhiệm runtime | giữ protocol/schema tách core; state authority ở server | chưa tách Frontend/History/Matching service vì RhinoQ chưa có bottleneck/evidence tương ứng |
| [Hatchet](https://github.com/hatchet-dev/hatchet) | `api-contracts`, `api`, `internal`, `pkg`, `sdks`, `sql`, frontend cùng monorepo | contract và SDK là boundary riêng; SQL/migration có ownership rõ | chưa thêm nhiều SDK hoặc frontend package trước nhu cầu thật |
| [Inngest](https://github.com/inngest/inngest) | Go core có `cmd`, `pkg`, `proto`, test; SDK ngôn ngữ nằm riêng | server correctness và language SDK tách nhau | không chuyển RhinoQ thành durable-function/workflow runtime |
| [Trigger.dev](https://github.com/triggerdotdev/trigger.dev) | apps, packages, internal-packages, docs và tests tách rõ trong TypeScript monorepo; typed client/frontend hooks là product surface | Task snapshot phải dùng được từ application/FE, không chỉ operator | không lấy cấu trúc Turbo monorepo cho Go core nhỏ hơn nhiều |
| [Temporal TypeScript SDK](https://github.com/temporalio/sdk-typescript) | client, worker, workflow, activity, common và proto là package riêng | chỉ tách package SDK khi capability/release lifecycle thật sự khác nhau | Node preview hiện vẫn một package vì chưa có release hoặc consumer pressure |

Đây là đối chiếu cấu trúc và boundary, không phải bằng chứng throughput,
reliability hoặc product-market fit.

## Điểm tốt hiện tại

- `internal/domain` không biết PostgreSQL, HTTP, CLI hoặc SDK.
- Application và Runtime gọi storage qua interface nhỏ trong `internal/ports`.
- Memory/PostgreSQL adapter cho phép contract test cùng semantics.
- `pkg/rhinoq` là public Go facade; `cmd` là composition/process entry point.
- Node SDK không chứa lease/retry/effect correctness.
- Migration có thứ tự và test PostgreSQL riêng.
- Task, Execution, Job, Effect và Outcome là state machine độc lập.

## Debt và ngưỡng phải refactor

### Public facade

`pkg/rhinoq/client.go` đã lớn vì vừa chứa public type, wiring và runtime method.
Task API mới nằm ở `pkg/rhinoq/tasks.go`. Từ nay capability mới phải có file
riêng. Tách thành Go module/package mới chỉ khi có release lifecycle hoặc
dependency khác thật; tránh làm người dùng phải compose nhiều client quá sớm.

### HTTP interface

`internal/interfaces/agent/server.go` đã lớn. Không thêm provider/Task handler
dài vào file này. Slice tiếp theo nên tách handler theo resource (`tasks_http`,
`jobs_http`, `effects_http`) nhưng giữ một `agent` package và một route owner,
để tránh churn public API.

### Contract parity

Go và Node Task types hiện được viết tay. Đây chấp nhận được cho Snapshot v1
đang thử nghiệm, nhưng không mở SDK thứ hai trước khi có golden fixtures hoặc
code generation kiểm parity. Không đưa domain record trực tiếp vào protobuf.

### Adapter package

`internal/adapters/postgres` và `memory` đang flat, file-per-capability. Cấu trúc
này vẫn dễ tìm. Chỉ chia subpackage khi một adapter cần dependency/config/test
lifecycle riêng; chia sớm sẽ làm transaction dùng chung khó hơn.

### Service extraction

Giữ modular monolith cho tới khi đo được ít nhất một pressure cụ thể: lock/WAL,
connection budget, deploy isolation, security boundary, hoặc read workload làm
ảnh hưởng write path. Khi đó ưu tiên tách read model/control plane trước, không
tách authoritative state machine ngẫu nhiên.

## Quy tắc cho slice tiếp theo

1. Capability mới đi theo vertical slice xuyên các layer, không thêm vào
   `client.go` hoặc `server.go` chỉ vì tiện.
2. Public mutation dùng explicit command và expected entity version.
3. Transport map contract; không sở hữu state transition.
4. Runtime adapter chỉ bind/report Execution; Task lifecycle vẫn qua
   Application.
5. ProviderOperation phải thử với ít nhất hai provider semantics khác nhau
   trước khi chốt abstraction.
6. Realtime chỉ là delivery optimization trên Snapshot v1, không thành nguồn
   truth thứ hai.
