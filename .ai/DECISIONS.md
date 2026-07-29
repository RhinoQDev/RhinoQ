# Architecture decision records

## ADR-0001 — Modular monolith trước

- **Status:** accepted
- **Decision:** bắt đầu bằng một codebase, tách process khi có bottleneck đo được.
- **Reason:** giảm network failure và chi phí vận hành, vẫn giữ module boundary để scale sau.
- **Rollback:** có thể tách module thành package/service mà không đổi domain contract.

## ADR-0004 — Go authoritative engine, Node.js SDK

- **Status:** accepted
- **Decision:** Go sở hữu embedded client, HTTP Gateway, worker, scheduler,
  lease, retry và correctness; Node.js SDK cung cấp producer SQL, HTTP client
  và worker lifecycle nhưng không tự quyết định state transition.
- **Reason:** runtime hạ tầng cần binary độc lập, concurrency, resource control và hỗ trợ đa ngôn ngữ.
- **Constraint:** mọi giao tiếp qua versioned protocol; SDK không tự thực thi business state machine.
- **Rollback:** giữ protocol ổn định để thay client hoặc runtime mà không đổi public contract.

## ADR-0011 — Worker claim phải lọc theo handler đã đăng ký

- **Status:** accepted
- **Context:** claim toàn cục cho phép worker chuyên một job name lấy nhầm job
  của worker khác, gây permanent failure giả và lock contention.
- **Decision:** `ClaimInput`/HTTP claim nhận tối đa 256 queue names; memory và
  PostgreSQL adapter lọc trước khi lease. Go và Node worker luôn gửi registry
  names. SDK release job lạ nếu Gateway cũ không hỗ trợ filter.
- **Consequences:** worker heterogeneous có thể dùng chung store an toàn hơn;
  low-level caller để filter rỗng vẫn giữ hành vi all-queues tương thích.
- **Rollback:** bỏ filter khỏi caller sẽ quay về all-queues nhưng không cần đổi
  schema.
- **Owner:** engine + SDK

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

- **Status:** superseded by ADR-0014
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
- **Consequences:** violation tạo/dedup Finding; pass tự resolve Finding;
  scheduler dùng persistent cursor và fenced lease trên cùng contract. Không
  xây invariant DSL ở v0.1.
- **Rollback:** disable Rule version; definition và Explain evidence vẫn được giữ để audit.
- **Owner:** integrity engine

## ADR-0010 — Embedded Go mặc định, HTTP Gateway là tùy chọn

- **Status:** accepted
- **Context:** Bắt người dùng Go chạy thêm một process làm onboarding và vận
  hành phức tạp hơn, đồng thời tên `Agent` dễ bị hiểu sai thành AI/LLM.
- **Decision:** public Go API kết nối trực tiếp PostgreSQL là đường mặc định.
  CLI cũng dùng cùng public boundary. Binary `rhinoq-agent` hiện tại chỉ là
  authenticated HTTP Gateway cho worker không phải Go; không có LLM và không
  được yêu cầu trong quickstart.
- **Consequences:** migration, doctor, operations và Rule scheduler phải dùng
  được không qua Gateway. Tài liệu đa ngôn ngữ vẫn giữ protocol/fencing ở Go
  thay vì nhân correctness sang SDK.
- **Rollback:** nếu design partner thực tế cần remote control plane, có thể
  nâng Gateway thành deployment chính mà không đổi domain/port contract.
- **Owner:** product + engine

## ADR-0012 — Workbench local, read-only và embed trong Go binary

- **Status:** accepted
- **Context:** developer cần xem job/effect/outcome nhanh nhưng một hosted
  Console tạo thêm process, auth, deployment và frontend dependency trước khi có
  design-partner evidence.
- **Decision:** `rhinoq workbench` bind `127.0.0.1`, embed static assets và gọi
  public application facade qua một Reader read-only. Browser contract bounded,
  không chứa payload/credential; v0 không có write action.
- **Alternatives:** React/Vite service riêng bị loại ở v0 vì tăng install/runtime
  cost; query trực tiếp PostgreSQL từ HTTP bị loại vì phá layer boundary.
- **Consequences:** Go CLI là cách mở UI cho cả Go và Node adopter; production
  Console/auth/RBAC vẫn là scope riêng. Browser mutation tương lai phải đi qua
  application use case với actor, reason và audit.
- **Rollback:** có thể bỏ command/embedded assets mà không đổi domain, storage
  schema hoặc worker runtime.
- **Owner:** DX + engine

## ADR-0013 — Apache-2.0 và public distribution boundary

- **Status:** accepted
- **Context:** repository không có file license nên mặc định là "all rights
  reserved": không ai được phép dùng, fork hay redistribute một cách hợp pháp,
  kể cả khi repository ở chế độ public. Đồng thời module path khai báo
  (`github.com/rhinoq/rhinoq`) không trùng nơi host thật, nên `go get` không
  resolve được và mọi consumer phải dùng `replace` local.
- **Decision:** core RhinoQ dùng **Apache-2.0** — Go engine, domain,
  application, runtime, protocol, CLI, Node.js SDK, docs và test. Module path
  đổi thành `github.com/madebyduy/RhinoQ` để trùng repository đang host, kèm
  `NOTICE` theo mục 4(d) của license.
- **Alternatives:** AGPLv3 + commercial (bị loại vì nhiều công ty cấm AGPL
  trong policy, chặn adoption ở giai đoạn cần design partner); BSL/source-
  available (bị loại vì không được gọi là open source, mất tín hiệu tin cậy khi
  sản phẩm còn phải chứng minh differentiator); MIT (bị loại vì thiếu điều
  khoản patent grant, rủi ro không cần thiết cho hạ tầng dữ liệu).
- **Consequences:** Apache-2.0 không ngăn bên khác chạy hosted service trên
  core. Giá trị thương mại phải nằm ở managed service, enterprise Console,
  support/SLA và thương hiệu, đúng như `GOVERNANCE.md` đã ghi — không nằm ở
  license. Mọi dependency mới phải tương thích Apache-2.0; GPL/AGPL không được
  đưa vào core.
- **Boundary:** product research chưa publish (`private/`) không đi kèm license
  này và không được coi là implementation truth.
- **Rollback:** không thể thu hồi license cho commit đã public. Chỉ có thể đổi
  license cho các release về sau, và cần đồng thuận của mọi contributor giữ
  copyright.
- **Owner:** maintainer

## ADR-0014 — Task Platform với Verified Tasks là hai lớp sản phẩm

- **Status:** accepted
- **Context:** định hướng hiện tại tập trung vào integrity workflow, trong khi
  nhu cầu user-facing async task có cửa vào rộng hơn. Repository đã có runtime,
  fencing, retry, Effect Ledger, Outcome, Rule và Finding; xóa chúng sẽ làm mất
  tài sản correctness, nhưng đưa toàn bộ integrity vào onboarding Task sẽ làm
  sản phẩm nặng và khó kiểm chứng.
- **Decision:** RhinoQ đặt **Task Platform** làm cửa vào sản phẩm. Task sở hữu
  lifecycle user-facing, execution, progress, cancel, retry, history, result và
  delivery. **Verified Tasks** là capability tùy chọn cho effect, outcome,
  Finding và reconciliation. Mô hình mới thêm `Task` phía trên `Execution`; Job
  hiện tại tiếp tục là execution/runtime primitive trong slice đầu tiên.
- **Runtime boundary:** Native Go/PostgreSQL là backend đầu tiên; runtime hiện
  có của người dùng, bắt đầu với BullMQ, được tích hợp qua adapter. RhinoQ không
  yêu cầu migration queue để dùng Task Platform.
- **Provider boundary:** ProviderOperation là primitive generic cho request ID,
  polling/webhook, timeout, idempotency, confirmation và `uncertain`. Không xây
  marketplace hoặc business connector hàng loạt trong slice đầu tiên.
- **Delivery boundary:** durable snapshot/state model đi trước realtime. Polling
  là transport đầu tiên; SSE, stream, Redis fan-out và WebSocket chỉ được thêm
  sau khi snapshot, versioning, retry và reconnect semantics có test.
- **Alternatives:** giữ integrity làm cửa vào duy nhất (hẹp và onboarding nặng);
  bỏ integrity (mất khác biệt correctness); xây song song hai sản phẩm độc lập
  (trùng infrastructure và tăng scope).
- **Consequences:** phải định nghĩa quan hệ Task–Execution–Job, giữ backward
  compatibility cho API Job, tách Task state khỏi Outcome/Effect state, và
  cập nhật README/architecture/status trước khi thêm code Task. Các phần Rule,
  Finding và Effect Ledger không bị xóa.
- **Rollback:** nếu validation không chứng minh được nhu cầu Task, giữ Task
  model như facade/adjacent capability và quay lại ưu tiên Verified Tasks mà
  không cần xóa runtime hoặc integrity foundation.
- **Owner:** product + engine

## ADR-0015 — Contract thuần dữ liệu và dependency gate tự động

- **Status:** accepted
- **Context:** Snapshot contract ban đầu tự import Domain để dựng DTO. Cách này
  tiện trong một file nhưng tạo dependency hai chiều ở cấp kiến trúc vì Domain
  được phép import contract. Khi thêm HTTP, SDK và provider, contract sẽ dễ trở
  thành nơi chứa mapper/business logic và có thể tạo import cycle thật.
- **Decision:** `internal/contracts` chỉ chứa data, schema version và validation
  không phụ thuộc Domain. Mapping Domain ↔ contract thuộc Application. Test
  `tests/unit/architecture_test.go` parse import của production Go files và
  fail khi contracts/domain/ports/application/runtime/adapters đi sai hướng.
- **Evidence:** Temporal tách API/proto khỏi server services; Hatchet có
  `api-contracts`, `api`, `internal`, `pkg`, `sdks`, `sql`; Temporal TypeScript
  SDK tách client/worker/workflow/common/proto thành package riêng. RhinoQ áp
  dụng dependency separation nhưng không sao chép số lượng package/service.
- **Consequences:** mapper có thể nhiều hơn một bước nhưng wire DTO không kéo
  state nội bộ vào SDK/transport. Mọi layer mới phải thêm rule vào architecture
  test nếu nó tạo một boundary mới. `pkg/rhinoq` tiếp tục tách file theo
  capability; không dồn Task vào `client.go`.
- **Rollback:** có thể bỏ gate test mà không đổi runtime/schema, nhưng không
  chuyển mapper ngược vào contracts trừ khi ADR này được thay thế.
- **Owner:** engine + SDK

## ADR-0016 — Task version là aggregate Snapshot revision

- **Status:** accepted
- **Context:** Snapshot chứa cả Task fields và danh sách Execution. Nếu
  create/bind Execution chỉ tăng `Execution.Version`, hai Snapshot có thể cùng
  `entityVersion` nhưng khác nội dung. FE bỏ response cũ theo Task version khi
  đó không còn sound, đặc biệt khi request hoàn thành sai thứ tự.
- **Decision:** mọi insert/update Execution tăng parent `Task.Version` và
  `updated_at` trong cùng memory lock hoặc PostgreSQL transaction. Public
  create/bind Execution trả Snapshot mới. `Execution.Version` vẫn dùng để fence
  mutation của riêng attempt; `Task.Version` là revision của toàn aggregate
  được render.
- **Alternatives:** version tuple/merge client-side (tăng complexity cho mọi
  SDK và vẫn khó xử lý missing child); bỏ Execution khỏi Snapshot (mất history
  cần cho Task UI); event sequence riêng (thêm schema trước khi polling được
  chứng minh).
- **Consequences:** một Execution update làm stale Task command đang giữ version
  cũ, buộc caller đọc lại trước khi quyết định. Store contract đổi signature để
  trả aggregate version; adapter phải update cả hai record atomically.
- **Rollback:** cần contract version mới; không được quay lại semantics cũ trong
  Snapshot v1.
- **Owner:** engine + SDK

## ADR-0017 — Patched toolchain và Gateway fail-closed ở local boundary

- **Status:** accepted
- **Context:** `govulncheck` tìm thấy reachable advisories trong pgx 5.7.2,
  x/text 0.21.0 và Go 1.26.2. Bản vá pgx/x.text yêu cầu Go 1.25. Gateway đồng
  thời bind mọi interface mặc định, chấp nhận token ngắn và cho phép
  unauthenticated mode bind ra network nếu operator cấu hình nhầm.
- **Decision:** minimum Go baseline là 1.25.0 và preferred toolchain là bản vá
  1.26.5; CI phải dùng setup-go có hiểu `toolchain` directive và chạy
  `govulncheck` cho cả hai module. Gateway mặc định bind
  `127.0.0.1:8080`, token phải ít nhất 32 byte, unauthenticated mode chỉ chạy
  trên loopback, và HTTP/parser boundary phải bounded, không phản chiếu raw
  internal error.
- **Boundary:** đây không phải tenant/role auth. Một Agent token vẫn là
  deployment credential chung; remote traffic phải qua TLS termination và
  network policy. Task `ownerId` chưa phải authorization claim.
- **Alternatives:** giữ Go 1.22 và chấp nhận dependency dễ tổn thương (refused);
  fork/backport pgx (tăng supply-chain ownership); thêm TLS/JWT/RBAC vội trong
  cùng change (sai vì chưa có auth model chuẩn hóa).
- **Consequences:** consumer cần Go 1.25+; CI/dev có thể tải preferred toolchain.
  Deployment trước đây dựa vào default `:8080` phải đặt
  `RHINOQ_AGENT_ADDRESS` rõ ràng và chịu trách nhiệm TLS/network policy.
- **Rollback:** chỉ hạ baseline nếu dependency graph được chứng minh sạch bằng
  scanner và có bản vá tương thích. Không rollback fail-closed bind/token rule
  nếu chưa có security review thay thế.
- **Owner:** engine + security

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
