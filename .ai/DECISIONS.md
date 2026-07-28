# Architecture decision records

## ADR-0001 — Modular monolith trước

- **Status:** accepted
- **Decision:** bắt đầu bằng một codebase, tách process khi có bottleneck đo được.
- **Reason:** giảm network failure và chi phí vận hành, vẫn giữ module boundary để scale sau.
- **Rollback:** có thể tách module thành package/service mà không đổi domain contract.

## ADR-0004 — Go authoritative engine, TypeScript SDK

- **Status:** accepted
- **Decision:** Go sở hữu Agent, worker, scheduler, lease, retry và correctness; TypeScript cung cấp SDK/CLI cho ứng dụng Node.js.
- **Reason:** runtime hạ tầng cần binary độc lập, concurrency, resource control và hỗ trợ đa ngôn ngữ.
- **Constraint:** mọi giao tiếp qua versioned protocol; SDK không tự thực thi business state machine.
- **Rollback:** giữ protocol ổn định để thay client hoặc runtime mà không đổi public contract.

## ADR-0002 — PostgreSQL là authoritative store mặc định

- **Status:** accepted
- **Decision:** job state, effect ledger và outcome evidence nằm ở PostgreSQL mặc định.
- **Reason:** transaction, relational correlation, audit và reconciliation.
- **Constraint:** phải đo WAL, lock, connection và query cost; không được xem đây là claim throughput.

## ADR-0003 — Confirmation là policy explicit

- **Status:** accepted
- **Decision:** `effect.run()` nhận `confirm` policy; callback return không mặc định là outcome.
- **Reason:** provider có thể trả `202 Accepted` hoặc trạng thái processing.

## ADR-0005 — Fencing bằng `(lease_owner, lease_epoch)`

- **Status:** accepted
- **Context:** `lease_id` ngẫu nhiên mỗi lần claim không cho biết ai đang giữ job, và không phát hiện được worker cũ quay lại ghi state sau khi đã mất lease.
- **Decision:** `lease_owner` là identity của worker, `lease_epoch` tăng mỗi lần claim. Mọi write của execution phải trình đúng cả hai: heartbeat, complete, fail, release, begin effect, confirm effect. Sai thì write bị từ chối với `ErrLeaseLost`.
- **Alternatives:** chỉ dùng `lease_id` ngẫu nhiên (không truy vết được owner), hoặc signed attempt token (không chặn được write khi database không có fencing counter).
- **Consequences:** claim ghi thêm một cột; mọi port của lease đổi chữ ký. Bù lại một stale execution không thể ghi đè state của execution đang sống.
- **Rollback:** `lease_id` vẫn còn trong schema cho tới contract migration; có thể quay lại bằng cách bỏ điều kiện epoch trong `WHERE`.
- **Owner:** engine

## ADR-0006 — DB time là clock authority

- **Status:** accepted
- **Context:** worker tự tính `not_before` và lease expiry rồi gửi lên, nên clock skew giữa worker làm lease hết hạn sớm hoặc retry chạy sai giờ.
- **Decision:** PostgreSQL tính mọi mốc thời gian bằng `now()`. Retry gửi một khoảng (`RetryIn`), không phải một thời điểm. Worker nhận `lease_until` từ `RETURNING` của câu claim.
- **Consequences:** `FailureTransition.NotBefore` được thay bằng `RetryIn`; memory store cộng khoảng đó vào clock của chính nó để giữ cùng ngữ nghĩa.
- **Rollback:** không cần; đây là ràng buộc chặt hơn ràng buộc cũ.
- **Owner:** engine

## ADR-0007 — v0.1 là Integrity Slice trong một PostgreSQL job queue

- **Status:** accepted
- **Context:** PostgreSQL queue parity có switching cost cao và không tạo khác biệt đủ mạnh so với BullMQ, pg-boss, Graphile Worker, PGMQ hoặc các durable execution platform. Hoãn VERIFY/RECOVER tới sau khi có user tạo vòng lặp không thể đạt: sản phẩm cần differentiator để có design partner.
- **Decision:** RhinoQ vẫn là PostgreSQL job queue. v0.1 phải kiểm chứng một business invariant từ record ngược về execution/effect, lưu finding bền vững và hỗ trợ operator lifecycle có audit. `scan`/observe-only cho phép đánh giá trên execution system hiện hữu trước khi người dùng quyết định adopt queue.
- **Alternatives:** release queue foundation trước; yêu cầu migrate queue; chỉ trả `needs_decision` mà không có verifier/reconciliation.
- **Consequences:** queue foundation được giữ ổn định; persistent finding, Rule, correlation timeline và scan được ưu tiên trước DAG, adapter thứ hai và queue parity mở rộng. README phải nói rõ khi nào nên dùng sản phẩm khác.
- **Rollback:** nếu ba design partner không coi invariant/finding là reusable product capability, dừng mở rộng product layer và giữ queue/runtime như research foundation.
- **Owner:** product + engine

## ADR-0008 — Durable execution là adjacent solution, không phải blind spot

- **Status:** accepted
- **Context:** DBOS, Hatchet, Restate và Temporal checkpoint hoặc journal execution, giải nhiều crash/replay window tốt hơn queue truyền thống. Tuy nhiên external API không mặc nhiên exactly-once; DBOS Go step chính thức vẫn mô tả at-least-once ngoài datasource transaction.
- **Decision:** RhinoQ không tuyên bố độc quyền giải worker crash. Effect Ledger là evidence/confirmation primitive cho effect không nằm trọn trong transaction hoặc durable-call protocol. Mọi case study phải so với durable execution + provider idempotency + application reconciliation.
- **Consequences:** differentiator cần được kiểm chứng ở business outcome invariant và reverse reconciliation; tài liệu cạnh tranh phải dùng nguồn chính thức và ghi ngày review.
- **Rollback:** không áp dụng; đây là giới hạn claim, không phải coupling kỹ thuật.
- **Owner:** product

## ADR-0009 — Một Rule model, draft phải qua PostgreSQL Explain trước khi enable

- **Status:** accepted
- **Context:** Outcome và Reconciliation tách thành hai API làm tăng surface area nhưng cùng trả lời một câu hỏi: subject có vi phạm invariant không. Raw SQL linh hoạt nhưng một query thiếu index hoặc không bounded có thể gây incident production.
- **Decision:** dùng một Rule contract có scope `job` và `table`. Query trả `subject_id`, `violated`, `evidence`; table scope nhận baseline/cursor/limit. Definition append-only theo version, luôn bắt đầu `draft`; enable chạy PostgreSQL Explain trong read-only transaction, kiểm result shape, statement timeout, hard limit, plan cost và large sequential scan.
- **Security boundary:** syntax guard không phải SQL sandbox. Production cần restricted read-only role và không grant function/extension có filesystem/network side effect.
- **Consequences:** violation tạo/dedup Finding; pass tự resolve Finding; scheduler cursor persistence làm sau trên cùng contract. Không xây invariant DSL ở v0.1.
- **Rollback:** disable Rule version; definition và Explain evidence vẫn được giữ để audit.
- **Owner:** integrity engine

## Template cho ADR mới

```text
## ADR-NNNN — Title
- Status: proposed | accepted | superseded
- Context:
- Decision:
- Alternatives:
- Consequences:
- Rollback:
- Owner:
```
