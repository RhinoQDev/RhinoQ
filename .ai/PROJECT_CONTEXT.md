# Project context

## Sản phẩm

RhinoQ là Task Platform với hai lớp:

- **Task Platform:** lifecycle user-facing cho công việc bất đồng bộ, execution,
  progress, cancel, retry, history, result và delivery.
- **Verified Tasks:** Effect Ledger, outcome verification, Findings và
  reconciliation cho các task cần chứng minh business result.

Task là cửa vào sản phẩm. Job/runtime hiện tại là execution primitive được tái
sử dụng; không đổi tên hoặc xóa trong slice đầu tiên. `scan`/observe-only vẫn là
đường đánh giá trên execution system hiện hữu và thuộc lớp Verified Tasks.

## Mục tiêu hiện tại

- Xây Go modular monolith trước; Node.js/TypeScript là producer,
  worker-lifecycle và SDK developer-facing cho Task Platform.
- Giữ dependency một chiều giữa contracts, domain, application, runtime, ports, adapters và infrastructure.
- Chưa tuyên bố throughput/latency production khi chưa có benchmark tái lập.
- PostgreSQL là authoritative store mặc định cho durable Task state, execution
  history và evidence; Redis chỉ là capability tùy chọn về sau.
- Embedded Go là deployment mặc định: application dùng public client trực tiếp
  với PostgreSQL, không cần server riêng. Native runtime là một backend,
  không phải yêu cầu bắt buộc nếu application đã có queue.
- `rhinoq-agent` chỉ là HTTP Gateway tùy chọn cho worker không phải Go; nó
  không phải AI agent và RhinoQ không cần LLM.

## Thuật ngữ bắt buộc

- `request accepted`: provider đã nhận request.
- `effect confirmed`: có bằng chứng effect đã hoàn thành.
- `outcome achieved`: business invariant đã đạt.
- `uncertain`: chưa đủ bằng chứng; không được coi là success.
- `irreversible`: thuộc tính của từng effect, không phải của toàn bộ job.

## Trạng thái scaffold

Đã có Go engine/domain/application/ports, PostgreSQL adapter, worker runtime,
Rule scheduler, Finding inbox và CLI vận hành trực tiếp. Node SDK preview có
producer SQL, typed Gateway client và high-level worker với queue-filtered
claim. Local read-only Workbench đã có jobs, evidence, Needs Attention,
Findings, Rules và bounded scan. Task/Execution domain, store ports, memory
adapter, application lifecycle/progress commands và versioned Snapshot DTO đã
có test. Migration 015 và PostgreSQL store đã pass contract trên PostgreSQL 16.
Public Go Task facade, HTTP polling, result-reference API và typed Node Task
client đã có test. Runtime adapter, ProviderOperation, result payload/realtime
delivery, production Console và protocol generation chưa hoàn thiện.
