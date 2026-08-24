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

- **Status:** superseded in part by ADR-0021; loopback/privacy boundary remains
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

## ADR-0018 — BullMQ lifecycle bridge is observation, not a second queue

- **Status:** accepted
- **Context:** Task Platform needs evidence that an existing BullMQ application
  can gain a user-facing lifecycle without moving its worker. The current Task
  contract has no input/dispatch command identity and no composed retry
  transaction. Adding a generic Redis queue or Task-to-BullMQ outbox now would
  either duplicate BullMQ or make a crash-prone promise it cannot keep.
- **Decision:** Node exposes `BullMQTaskBridge`, structurally compatible with
  an application-owned BullMQ `QueueEvents`. The application adds the job and
  calls `track()`. The bridge creates/binds a durable `bullmq` Execution and
  projects observed lifecycle through Go's version-fenced Application/Gateway
  APIs. PostgreSQL Task/Execution state is the source of truth; the bridge does
  not own Redis or import BullMQ. A `failed` event changes Task state only when
  the application supplies a terminal-failure classifier.
- **Alternatives:** implement BullMQ persistence/worker semantics in Go
  (rejected: second queue); add Redis as a core Task dependency (rejected:
  polling snapshot already has a durable source of truth); retain manual
  Execution binding only (rejected: does not test event projection).
- **Consequences:** V1 has no auto-dispatch, cancellation, retry-to-new-
  Execution orchestration or outage-wide reconciliation. Repeating `track()`
  after a bridge restart is safe through `(runtime, external_id)` lookup; the
  application may also reconcile one known Job state it reads from BullMQ.
  Redis may later be an optional delivery invalidation capability, never the
  correctness source for a Task snapshot.
- **Rollback:** stop instantiating the bridge. Existing Task/Execution records
  remain auditable; no Redis-owned RhinoQ state or queue schema has to be
  removed.
- **Owner:** engine + Node SDK

## ADR-0019 — Runtime adapters must declare Task terminal projection

- **Status:** accepted
- **Context:** a real adopter maps one user-facing bulk download Task to N
  BullMQ jobs. Letting each observed job complete/fail the parent Task makes the
  first item terminalize the whole batch. Inferring a generic aggregation rule
  in the Node SDK would move Task correctness out of the Go/application
  boundary and turn a lifecycle adapter into a workflow engine.
- **Decision:** lifecycle bridges declare terminal projection explicitly.
  `single-execution` may project one terminal Execution onto its Task.
  `execution-only` records each terminal Execution but leaves aggregate Task
  completion/failure to the application, which owns the business completion
  condition. Progress monotonicity and cancellation outcomes remain Go domain
  invariants, independent of runtime.
- **Alternatives:** one Task per fan-out item (rejected because it pushes
  aggregation back to every frontend); auto-complete after all currently known
  Executions (rejected because an early item can finish before all N items are
  registered); generic workflow policies in V1 (deferred until adopter evidence
  proves reusable semantics).
- **Consequences:** fan-out adopters must configure `execution-only` and issue
  the final Task command when the aggregate deliverable is known. This is
  explicit additional work, but it cannot report false success.
- **Rollback:** remove the option and stop using the bridge for fan-out; durable
  Execution records remain valid.
- **Owner:** engine + Node SDK

## ADR-0020 — Task-only PostgreSQL profile and embedded Node command client

- **Status:** accepted
- **Context:** the real BullMQ adopter deleted 535 lifecycle lines but added
  997, one Gateway process and three credential classes. A Task-only adopter
  also had to apply migrations 001–017, creating 17 tables although Task state
  used only Task and Execution. This cost made the measured verdict NO-GO even
  though 23/23 correctness scenarios passed.
- **Decision:** Task Platform gains an isolated `rhinoq_task` PostgreSQL
  profile with exactly three tables: migration history, Tasks and Executions.
  Native runtime and Verified Tasks become separate opt-in schema profiles.
  Task Executions store a runtime scope and external ID without a foreign key
  to the optional native Job table.
- **Command authority:** production mutations in the Task-only profile go
  through versioned `rhinoq_task.*` database functions. The embedded Node
  `PostgresTaskClient` and future Go Task-only facade call the same commands;
  SDKs do not reimplement transition, monotonic-progress, duplicate,
  cancellation or aggregate-version rules. PostgreSQL is already mandatory,
  so this removes a process without adding a technology.
- **Execution identity:** `itemKey` identifies one logical fan-out item and
  `attempt` increments per item. Runtime identity is
  `(runtime, runtimeScope, externalId)` because IDs such as BullMQ job IDs are
  scoped by queue. Reserving that identity before enqueue leaves a recoverable
  `pending_dispatch` record across a crash.
- **Delivery boundary:** applications continue to own user authentication.
  A small application HTTP handler filters every read/cancel by owner and a
  browser client consumes that endpoint; operator credentials never enter the
  browser or the embedded path.
- **Compatibility:** the legacy full schema and Gateway remain available
  during the beta transition. Existing migration checksums are not rewritten
  and old tables are never dropped automatically. A later adopt/copy command
  must precede removal.
- **Alternatives:** keep optimizing the Gateway (does not remove the extra
  process); copy the Go state machine into TypeScript (two correctness
  authorities); ship a native Node addon (cross-platform build and ABI cost);
  require all 17 tables (failed measured adoption).
- **Consequences:** PostgreSQL command functions are now a versioned public
  boundary for Task-only persistence and need real-database parity tests.
  Fresh Task-only installs create three tables; full runtime/verification
  installs can still be larger by explicit choice.
- **Rollback:** stop using `PostgresTaskClient` and use the Gateway client.
  The isolated schema can remain unused or be removed deliberately after data
  export; no runtime/verification tables depend on it.
- **Owner:** product + engine + Node SDK

## ADR-0021 — Bounded Task reads, ProviderOperation and guarded repair

- **Status:** accepted
- **Context:** fan-out benchmarks showed the compatibility Snapshot grows with
  every Execution, while payment/provisioning calls and business repairs need
  explicit unknown-result semantics rather than another queue retry.
- **Decision:** Task polling uses an execution-free Summary and stable keyset
  Execution pages; the full Snapshot remains for compatibility. Go owns a
  durable ProviderOperation state machine keyed by provider/operation/idempotency
  key. Unknown network results fail closed as `uncertain` and are resolved by
  read-back or webhook proof. Repairs are registered application handlers and
  require preview, a different approver, a fresh precondition, an idempotent
  apply token and post-apply verification.
- **Notification boundary:** generic signed webhook and Slack delivery are
  explicit, evidence-redacted by default and deduplicated durably per event and
  destination. The delivery ledger also supports queued multi-node dispatch
  with a PostgreSQL row lease, persisted backoff and an explicit dead-letter
  state; destination resolution and secrets remain application-owned.
- **Workbench boundary:** ADR-0012's arbitrary-mutation prohibition remains,
  but read-only operation is no longer mandatory. An explicitly action-enabled
  loopback Workbench may call recheck and guarded repair Application use cases.
  Business mutation runs only through an in-process registered handler or an
  allowlisted, HMAC-signed application callback; browser-supplied SQL is never
  accepted.
- **Alternatives:** offset pages (unstable under append); retry timeouts as
  failures (can double-charge); arbitrary repair SQL (unreviewable and unsafe);
  copying state machines into TypeScript (two correctness authorities).
- **Consequences:** full-profile databases require migrations 018–025. The
  Task-only Node profile stays at exactly three tables. Node ProviderOperation
  and repair HTTP helpers reserve/transition state through Go; SDK callbacks do
  not implement the state machine. Task polling reads stored aggregate counts
  and fetches Execution pages only on demand.
- **Rollback:** callers can keep using full Task Snapshots and avoid the new
  APIs; migrations are additive and do not rewrite existing rows.
- **Owner:** product + engine + Node SDK

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

## ADR-0022 — Transactional per-item application effect gate

- **Status:** accepted
- **Context:** an existing BullMQ worker can retry the same logical item after
  a process or acknowledgement failure. Observing the retry is not enough for
  application writes such as credit logs or inventory deductions; the adopter
  needs a small guard without replacing BullMQ or adding a fourth Task-profile
  table.
- **Decision:** the Task-only PostgreSQL profile adds an append-only set of
  named `effect_keys` to Executions and the versioned
  `rhinoq_task.claim_item_effect` command. `PostgresTaskClient.onceForItem()`
  opens one transaction, claims the key across all attempts for the item, and
  passes the same checked-out connection to the application callback. A
  committed callback returns `executed: false` on a later retry; a callback
  error rolls the claim back. Provider calls remain outside this promise and
  must use ProviderOperation/idempotency/confirmation.
- **Alternatives:** a TypeScript in-memory lock (lost on restart); a Redis
  counter (not atomic with PostgreSQL business data); a fourth effect table in
  the Task-only profile (more durable but raises onboarding/storage cost); or
  replacing BullMQ with a workflow engine (outside RhinoQ's boundary).
- **Consequences:** the profile still owns exactly three tables and PostgreSQL
  remains the correctness authority. The callback must use the supplied
  transaction connection; a pool-backed client is required. The marker is
  bounded to 256 keys per item and increments the aggregate version with the
  execution mutation.
- **Rollback:** stop calling `onceForItem`, set the bridge to its prior retry
  behavior, and apply an additive rollback migration only after no marker is
  needed. Existing Task/Execution rows remain readable without the helper.
- **Owner:** engine + Node SDK

## ADR-0023 — Request-bound effects and durable recovery queues

- **Status:** accepted
- **Context:** a convenient provider helper must not make it easier to reuse
  one idempotency key for a different command. Projection failures and
  notifications also need durable operator/scheduler workflows, but runtime
  adapters and destination secrets are application-owned.
- **Decision:** Effect Ledger Lite derives a command key when explicit identity
  is supplied and sends a deterministic request fingerprint to Go. The Go
  ProviderOperation record rejects a key whose fingerprint, task or policy
  differs. Projection failures use an application-owned inbox with claim,
  replay, retry and ignore states. Notification deliveries persist their
  message payload, use PostgreSQL `FOR UPDATE SKIP LOCKED` plus a row lease,
  exponential backoff and a bounded `dead` state.
- **Alternatives:** derive identity only in Node (the Go ledger could not fence
  a changed request); retry a failed projection from the process callback
  (lost on restart); put provider secrets in the delivery table (unsafe); or
  use a process-local cron (duplicate sends across replicas).
- **Consequences:** migrations 024–025 are additive. A PostgreSQL failure
  inbox table remains outside the isolated Task-only profile. A scheduler
  can recover work after a process loss, but the application still resolves
  runtime state, notification destinations and secrets. Tenant-wide RBAC and
  deployment-shaped chaos evidence remain separate release gates.
- **Rollback:** stop constructing the new scheduler/inbox, continue using the
  synchronous notification/provider APIs, and leave the additive columns
  unused. Existing delivery and ProviderOperation rows remain readable.
- **Owner:** engine + Node SDK + product

## ADR-0027 — Snapshot-convergent owner Task SSE

- **Status:** accepted
- **Context:** TaskStore already handled stale versions, reconnect and polling,
  while adopters still kept hand-written SSE endpoints. No RhinoQ route emitted
  `text/event-stream`; Node adapters buffered every Fetch response with
  `response.text()`, which would hang for a stream.
- **Decision:** the application-owned Node Task surface exposes one owner-scoped
  item stream and one owner inbox stream. Events carry authoritative Task
  snapshots and entity versions; SSE is never a second state store. Item
  reconnect accepts `Last-Event-ID`; inbox reconnect replays the bounded page
  and clients converge by version. Fetch streaming supports application headers,
  while the reference page uses same-origin cookies. Stores fall back to a
  snapshot after loss and retry SSE. Heartbeats, abort cleanup and connection
  budgets are mandatory.
- **Alternatives:** native WebSocket state; browser-only EventSource without
  authorization headers; process-local progress events; or Redis Pub/Sub as the
  source of truth.
- **Consequences:** adopters receive live UX without weakening PostgreSQL truth
  or rewriting their worker. The default stream performs bounded server-side
  snapshot reads, so deployments must measure connection/database load; shared
  fan-out may be added later as an optimization with polling retained for
  convergence. The Go Gateway remains snapshot-only.
- **Rollback:** disable `stream`, keep the same routes/hooks on polling and leave
  stored Task data unchanged.
- **Owner:** Node SDK + product

## ADR-0037 — Low-code composition remains bounded and evidence-gated

- **Status:** accepted
- **Context:** the low-code upgrade plan asks RhinoQ to remove repeated setup,
  realtime, processor and operator glue, but automatic mutation or a hosted
  control plane would add authority before multi-cluster evidence exists.
- **Decision:** `defineRhinoQProject()` binds pool, identity, execution profile
  and operator mount; processor packs own readiness/workspace/cleanup glue;
  Autopilot observations, what-if simulation and canary approval artifacts are
  deterministic with `autoApply: false`; Plan
  Inspector and Integration Eraser are read-only. No slice may mutate adopter
  files, Task state, business outcomes, leases, retries or uncertain effects.
  A multi-cluster Control Plane is deferred until a design-partner pilot and
  must not proxy large data-path bytes.
- **Consequences:** the shortest path is available for evaluation without
  creating a second correctness engine. Sharp/LibreOffice/malware/AI packs,
  Autopilot canary execution/automatic phases, patch application and Control
  Plane production claims remain evidence gates.
- **Rollback:** remove the additive project/profile, pack, Autopilot and
  operator projections; existing compiler, runtime and Task contracts remain
  unchanged.
- **Owner:** Node SDK + product + architecture

## ADR-0038 — Mutation invalidation and execution capsules stay non-authoritative

- **Status:** accepted
- **Context:** low-code setup needs one place to describe schedule/resource/data
  intent and realtime UI should update after writes without making socket health
  part of Task correctness.
- **Decision:** compile schedule/resource/data-path fields into a bounded,
  read-only execution capsule; expose an optional best-effort mutation hook for
  producer dispatch and runtime projection writes; and derive Evidence Passport
  from authoritative Task/effect/verification/artifact reads. The hook may
  invalidate an application-owned realtime hub, but it cannot fail, retry or
  change the durable write. Runtime admission and occurrence creation remain
  engine/application-owned.
- **Consequences:** in-process consumers get automatic invalidation when they
  compose the hook; external replicas still need an explicit signal adapter or
  pilot. Capsule metadata improves inspection without moving lease, retry,
  effect or state-machine correctness into Node.
- **Rollback:** omit the optional realtime hook and ignore the additive capsule
  fields; the existing SSE/polling safety net and runtime contracts remain valid.
- **Owner:** Node SDK + runtime architecture

## ADR-0036 — WebSocket is a multiplexed delivery adapter, not Task state

- **Status:** accepted
- **Context:** SSE is sufficient for ordinary progress, but an application may
  already operate WebSocket infrastructure or need many Task subscriptions on
  one connection. Per-socket polling and full-state broker messages duplicate
  reads, serialization and correctness state.
- **Decision:** provide a dependency-free, stack-neutral WebSocket hub in the
  Node server surface. Group reads by tenant/owner/Task, fan out only newer
  authoritative snapshots, bound connections/subscriptions/backpressure and
  version the wire messages. Indexed invalidation is the normal low-latency
  path; bounded reconciliation polling repairs missed signals. Authentication and upgrade/origin policy remain
  application-owned. Redis/NATS may carry invalidation identity/version at
  larger scale but never become the canonical Task store.
- **Consequences:** adopters reuse an existing socket server with a small
  adapter and no mandatory broker. The Go engine continues to own leases,
  retries, cancellation, effects and state transitions. SSE/polling remains the
  default and recovery path.
- **Rollback:** stop accepting WebSocket peers and retain the unchanged owner
  SSE and polling API.
- **Owner:** Node SDK + product

## ADR-0034A — Task application compilation is explicit composition

- **Status:** accepted
- **Context:** `app.task()` removed duplicated producer/worker declarations but
  each Task still repeated adapter/runtime/scope, applications kept their own
  registries and mounts, and source-scanning discovery would execute or parse
  application code inconsistently across TypeScript build systems.
- **Decision:** Node exposes an explicit typed Task registry and execution
  profile. It compiles only application-facing bindings, a serializable manifest
  and the existing combined HTTP middleware. It does not own or reproduce lease,
  retry, effect-ledger, reconciliation or state-machine correctness. External
  effects and bounded retry policy remain explicit.
- **Consequences:** TypeScript infers dispatch inputs from one registry and
  standard integrations remove repeated wiring. Discovery is deterministic and
  does not scan/import arbitrary files. The lower-level APIs remain compatible.
- **Rollback:** applications can return to `createRhinoQApp()` and `app.task()`;
  no stored schema, wire contract or runtime behavior changes.
- **Owner:** Node SDK + architecture

## ADR-0034B — Recurring Tasks require deterministic occurrences and fenced leases

- **Status:** accepted, implementation in progress
- **Context:** process-local timers duplicate or lose recurring work during
  replica overlap, restart and clock skew. Adapter retry identity is not a
  substitute for durable schedule ownership.
- **Decision:** recurring business Tasks start with bounded interval schedules.
  Every due time produces an identity derived from schedule ID plus the UTC
  occurrence. Stores claim using owner/epoch leases and database time; dispatch
  success advances the schedule only through the same fence, while dispatch
  failure releases it with bounded backoff. Cron/timezone syntax waits for a
  separate DST contract.
- **Consequences:** the runtime scheduler can be tested independently of a queue
  and cannot invent duplicate occurrence identity after takeover. The feature is
  not public until PostgreSQL storage, migration, facade and failover tests land.
- **Rollback:** remove the unexported domain/runtime packages; no schema or public
  contract currently depends on them.
- **Owner:** Go engine + architecture

## ADR-0035 — Recovery and adoption evidence use explicit durable fences

- **Status:** accepted
- **Context:** A previewed repair must not be re-issued by a second operator or
  replica, and an in-process Shadow Mode counter cannot describe a deployment
  with several adopters. SQS also cannot be made to look like a push queue or a
  reliably cancellable runtime without inventing evidence.
- **Decision:** The Node `GuardedRecovery` workflow derives a stable repair ID
  from a caller idempotency key, requires preview, a different approver and a
  post-check, and can persist its execution fence in PostgreSQL. Adoption
  facts are append-only and deduplicated by event ID in an explicitly installed
  PostgreSQL profile; report aggregation is therefore replica-safe. The SQS
  proof adapter declares polling, unstable attempts and unsupported cancel,
  maps receive count to an observed attempt and reports missing readback as
  unknown. `createBullMQPortableIntegration()` composes BullMQ translation and
  control over the portable integration while the compatibility preset retains
  its public shape during migration.
- **Consequences:** Unknown recovery/readback remains visible rather than being
  retried or treated as failure. A lost recovery response consumes its fence as
  `uncertain`, so it cannot be retried blindly. Durable adoption totals require
  opting into the SQL profile and a stable replica ID; no runtime-wide or
  savings claim is made by the memory default. SQS hosts retain ownership of
  AWS clients and receipt handles.
- **Rollback:** Stop installing the optional profiles and remove the new
  factories/exports; existing repair rows, Task rows and BullMQ compatibility
  APIs remain valid.
- **Owner:** Node SDK + PostgreSQL adapter + architecture

## ADR-0033 — Failure Lab is additive, disposable and evidence-driven

- **Status:** accepted
- **Context:** A useful reliability demo must reproduce completed-but-wrong
  behavior, but a chaos command pointed at production could create the incident
  it is meant to teach. Runtime completion alone also cannot prove a missing
  artifact; absence of evidence is an unknown outcome.
- **Decision:** Failure Lab scenarios use public Task commands to create
  uniquely identified additive fixtures. The first scenario records one
  succeeded Execution with no result reference and transitions the Task to
  `uncertain`. Its explanation and safe action are deterministic. Optional
  `--recover` continues through GuardedRecovery preview, separate approval,
  simulated disposable output, verified evidence and a mandatory
  post-check. The CLI requires `--confirm-disposable` before resolving or
  opening a database.
- **Consequences:** teams can rehearse the hero flow without queue mutation,
  provider calls, deletes or blind retry. The lab repair is explicitly
  simulated and disposable; it proves product composition, not correctness of
  an application/provider-specific repair.
- **Rollback:** remove the lab command/service; created Tasks remain ordinary
  additive Task history and require no schema rollback.
- **Owner:** Node SDK + product

## ADR-0024 — Application-owned Task vertical slice

- **Status:** accepted
- **Context:** adopters had Task correctness primitives but still rebuilt an
  owner inbox, detail/history polling, cancel/retry/result routes and React UI
  states. Copying those pieces also encouraged retrying an `uncertain` effect
  or treating a process-local enqueue callback as crash-safe.
- **Decision:** the Node package provides one owner-authenticated application
  route surface, framework-neutral list/detail stores and UI semantics, React
  hook factories, a dependency-free reference Task Center, declared BullMQ
  Task definitions, fail-closed BullMQ cancellation and owner-aware result URL
  resolution. A user retry requires a caller-generated command id and an
  application-owned handler. That handler must commit its command identity,
  Task transition and enqueue/outbox intent durably; React and the SDK never
  become the correctness authority.
- **Alternatives:** ship styled framework components only; put retry state in
  React or Redis; accept a plain enqueue callback and call it crash-safe; or
  expose storage references directly to the browser.
- **Consequences:** Next/Nest applications can mount one route surface and
  reuse one client/UI contract. Styling and host authentication remain
  application-owned. List filters currently apply to the fetched owner page;
  large inboxes should provide server-side filtering. Durable composed retry
  still requires the adopter's transaction/outbox implementation.
- **Rollback:** stop mounting the routes or hooks and retain the lower-level
  Task client/bridge. No database migration or stored state changes.
- **Owner:** Node SDK + product

## ADR-0025 — Atomic Task retry command and dispatch intent

- **Status:** accepted
- **Context:** requiring a retry `commandId` at the HTTP boundary did not stop
  an adopter from dual-writing a Task transition and BullMQ enqueue. A crash
  between those writes could either lose the retry or enqueue it twice.
- **Decision:** Go Application exposes a retry command through
  `TaskRetryStore`. PostgreSQL serializes the command identity and commits the
  failed/cancelled → queued transition, a new immutable Execution, the command
  record and `task.retry.dispatch_requested` outbox event in one transaction.
  A repeated identity resolves to the same Execution and performs no mutation.
- **Alternatives:** keep an application callback in the Node route; use a
  process-local identity set; or enqueue directly before/after updating Task.
- **Consequences:** migration 029 adds one tenant-isolated command table. Outbox
  publication remains at-least-once, so the runtime publisher must use the
  event's stable command/execution identity when enqueueing. Unknown external
  outcomes must still fail closed; this is not an exactly-once claim.
  The intent contains a fingerprinted queue, job name and JSON payload. The
  standard transport is HTTPS with an exact-body HMAC; the Node receiver only
  accepts registered queues and uses the Execution id as BullMQ `jobId`.
- **Rollback:** stop invoking `Service.Retry`; leave the additive command table
  unused until its outbox is drained, then remove it only in a later migration.
- **Owner:** engine + PostgreSQL adapter

## ADR-0026 — Evidence-gated provider reconciliation and capability claims

- **Status:** accepted
- **Context:** ProviderOperation already reserved identity and failed closed on
  unknown results, but applications had no bounded public query for an
  outage-recovery sweep. Documentation could describe the ingredients without
  proving that a particular effect configured all of them.
- **Decision:** Go Application exposes an oldest-first bounded query for
  unresolved ProviderOperations. The Node reconciler accepts only registered
  read-back verifiers and cannot access the original mutation callback. A pure
  capability report downgrades an effect unless stable identity,
  provider-enforced idempotency, independent confirmation and retry only after
  `not_happened` proof are all present.
- **Alternatives:** store verifier callbacks in Go; retry every uncertain
  operation; let Node query tables directly; or claim exactly-once from ledger
  presence alone.
- **Consequences:** applications can automate safe confirmation recovery and
  expose an auditable per-effect guarantee. Provider-specific verifier code and
  authenticated webhook handling remain application-owned. Multi-replica
  deployments should elect one scheduler or tolerate duplicate read-only
  verification; version fencing makes conflicting resolutions safe.
- **Rollback:** stop the Node reconciler and attention query. Existing ledger
  rows and state transitions are unchanged.
- **Owner:** engine + Node SDK + product
## ADR-0028 — Durable waitpoints are versioned settlement aggregates

- **Status:** accepted
- **Context:** Async work often pauses for input, approval or a provider
  webhook. Keeping that pause in worker memory loses it on restart and makes
  duplicate callbacks capable of applying two different answers.
- **Decision:** RhinoQ persists a waitpoint with stable `(task_id,key)` identity,
  explicit payload schema version, deadline and optimistic entity version.
  Resolution carries a command identity and SHA-256 payload fingerprint.
  Identical repeats replay the durable result; conflicts and unknown settled
  states fail closed. Waitpoint changes advance the parent Task version so SSE
  consumers converge. Application-owned HMAC tokens may grant one scoped
  read/resolve capability; the signing secret stays outside RhinoQ storage.
- **Consequences:** A waitpoint provides effectively-once settlement, not
  exactly-once delivery of a webhook. Large payloads remain artifact
  references. Go owns the domain rules; the isolated Node profile invokes
  versioned PostgreSQL functions rather than reproducing transitions in SDK
  callbacks.
- **Rollback:** stop exposing waitpoint routes and helpers; leave the additive
  table unused until a later migration removes it.
- **Owner:** engine + PostgreSQL adapter + Node SDK + product

## ADR-0029 â€” Task tenant, verification and artifact records stay additive

- **Status:** accepted
- **Context:** owner identity alone cannot isolate two tenants, runtime success
  is not business verification, and a bare result reference cannot express
  integrity, expiry or lineage safely to a browser.
- **Decision:** Task schema v9 adds a non-empty tenant identity to every Task,
  append-only verification records, and versioned Artifact metadata. Every
  Node owner HTTP read carries tenant plus owner into the SQL predicate. The
  browser sees Artifact metadata only; the application resolves its private
  reference. Provider/effect evidence remains Go-owned and joins Flight
  Recorder only through an explicit Task correlation.
- **Consequences:** existing single-tenant data migrates to the named `default`
  tenant. Multi-tenant applications must provide `tenantFromRequest` from their
  authenticated session. Verification and Artifact records advance the Task
  version so live consumers converge. This does not replace full-profile RLS.
- **Rollback:** stop exposing the additive routes and leave v9 records unused;
  do not silently map multi-tenant traffic back to `default`.
- **Owner:** PostgreSQL adapter + Node SDK + product

## ADR-0030 — Runtime inspection is read-only evidence, not queue ownership

- **Status:** accepted
- **Context:** Operators need to distinguish a stuck Task from a paused queue,
  absent workers or an unreachable runtime. Generic queue dashboards already
  provide detailed provider controls, and duplicating those controls would
  blur RhinoQ's Task/evidence boundary.
- **Decision:** Application-facing runtime health is a pure-data contract.
  BullMQ implements it through a bounded adapter that may read counts, pause
  state, workers and default policy. The operator Workbench may show that
  evidence and safe application-relative or HTTP(S) links after its existing
  authorization gate. It does not expose payloads, raw provider errors or
  pause/retry/empty/delete operations. Unobservable worker state is `unknown`;
  it is never inferred as zero.
- **Consequences:** RhinoQ gives an operator enough context to choose the next
  tool without becoming a second queue control plane. Adopters may link an
  existing inspector such as bull-board while keeping authorization and queue
  mutation application-owned.
- **Rollback:** stop supplying the inspector and link callbacks; Task storage,
  projection and owner APIs are unchanged.
- **Owner:** Node SDK + product

## ADR-0031 — Runtime adapters supply facts; the Task client owns transitions

- **Status:** accepted
- **Context:** `BullMQTaskBridge` combined queue listeners, retry inference,
  dispatch and cancellation with portable Task projection. Reusing that class
  for another runtime would either import BullMQ semantics into core or copy a
  second state coordinator.
- **Decision:** Node defines portable `RuntimeRef`, `RuntimeEvent`,
  `RuntimeObservation` and capability contracts. `RuntimeTaskProjector`
  serializes events per complete runtime reference and invokes the existing
  fenced `TaskClient`; it does not inspect or control a runtime. Adapters must
  provide terminal failure and unknown reasons. Observe and Track do not
  require dispatch capability. A dispatch receipt that cannot be bound is
  reported as non-retryable `RHINOQ_RUNTIME_DISPATCH_UNCERTAIN` with the known
  receipt.
- **Consequences:** custom runtimes can prove Task lifecycle without BullMQ,
  while PostgreSQL/Go commands remain authoritative for legal transitions.
  BullMQ stays the supported production adapter. A portable BullMQ translator
  exists, but its compatibility facade remains on the legacy bridge until
  lease, fan-out settlement and fault tests pass through the new composition;
  a second production adapter must also pass contract and fault tests before a
  multi-runtime claim. Generic reconciliation is bounded to adapter inspection of
  an already-known reference; runtime-wide discovery remains future work.
- **Rollback:** stop exporting the preview runtime modules. Existing BullMQ
  APIs, Task schema and stored runtime references are unchanged.
- **Owner:** Node SDK + architecture

## ADR-0032 — Shadow Mode requires application-owned stable identity

- **Status:** accepted
- **Context:** Observe-only adoption must show existing work without taking
  dispatch/cancel ownership. Runtime events alone usually lack Task type,
  authenticated owner and stable business item identity; guessing those values
  would corrupt aggregation and authorization.
- **Decision:** an application resolver may map an unbound portable event to a
  complete Task request, Execution ID and the exact same `RuntimeRef`. RhinoQ
  creates/binds idempotently, re-reads the binding and replays the original
  event. A mismatched reference fails before writes; `undefined` stays
  unresolved. Adoption reports count only events seen in this process and
  capability gaps reported by configured adapters.
- **Consequences:** existing producer and worker contracts remain unchanged,
  while a fast first-seen terminal event is not lost. The default report is
  process-local; the optional PostgreSQL adoption-event profile supports
  replica-safe totals. Neither path claims code savings or reliability
  improvement without external evidence.
- **Rollback:** remove the resolver and in-process report; explicit Track and
  Control paths and all durable Task rows remain valid.
- **Owner:** Node SDK + product

## ADR-0034 — Incident explanation is deterministic and capability-gated

- **Status:** accepted
- **Context:** Operators need one answer joining Task, attempts, verification
  and provider evidence. Free-form or AI-authored conclusions cannot safely
  decide whether an outcome is correct or whether a runtime mutation is
  eligible. Hiding an action in the browser alone is not a safety boundary.
- **Decision:** `IncidentExplanation` is a pure bounded projection of stored
  evidence and runtime capability reports. Business outcome is selected only
  from verification status; technical success without verification remains
  unknown. Workbench renders the model and exposes it behind the operator gate.
  Backend cancellation repeats capability checks before Task mutation.
- **Consequences:** UI and API agree on affected scope, evidence, likely causes
  and action availability. Missing capabilities stay unknown, explicit
  unsupported capability is refused, and optional AI may later paraphrase but
  cannot alter state/severity/eligibility.
- **Rollback:** stop rendering/exposing the derived explanation. Durable Task,
  verification and provider records are unchanged.
- **Owner:** Node SDK + product

## ADR-0035 — Direct multipart bytes bypass the Task queue

- **Status:** accepted
- **Context:** multi-GB browser files cannot safely be buffered by the Node API
  or carried in PostgreSQL/BullMQ. Multipart completion may lose its response,
  and retention deletion can race across replicas.
- **Decision:** persist owner/tenant-fenced upload sessions and sign direct
  provider parts. Reconcile provider parts on resume, require a real checksum
  for Task attachment, verify readback, and map unknown completion to
  `uncertain`. Keep session/artifact expiry separate. Cleanup is bounded,
  leased and explicit; delete provider bytes before metadata. The queue carries
  only an opaque reference.
- **Consequences:** server memory does not grow with file size while bucket
  policy, checksum production, codecs and business retry remain application
  decisions. This additive Node surface does not move job correctness out of
  the Go engine.
- **Rollback:** stop mounting upload routes and cleanup scheduling. Abort stored
  incomplete provider sessions before dropping the additive table/columns.
- **Owner:** Node SDK + product

## ADR-0039 — Tenant-fenced owner access for waitpoints and Executions

- **Status:** accepted
- **Context:** The embedded Task profile already carries `tenant_id` on Tasks,
  but the waitpoint settlement function and the low-level Execution read/
  transition methods could be called without tenant context. That is safe only
  for trusted runtime adapters; if mounted as an owner API, an attacker who
  knows an opaque waitpoint or Execution ID could cross an owner or tenant
  boundary. Waitpoint capability claims also did not carry the tenant needed by
  the SQL predicate.
- **Decision:** Migration 13 adds an eight-argument waitpoint resolver whose
  predicate includes both `tenant_id` and `owner_id`. The previous seven-
  argument resolver remains only as a fail-closed compatibility trap returning
  `RHINOQ_TENANT_REQUIRED`. Waitpoint capability tokens are schema version 2
  and must include tenant identity. `PostgresTaskClient` exposes explicit
  owner-scoped Execution read and transition methods; their SQL joins through
  the owning Task and returns not-found for a mismatched scope. The existing
  unscoped Execution methods remain runtime/adapter primitives and are not
  tenant-facing APIs.
- **Consequences:** Existing version 1 waitpoint tokens are rejected and any
  direct caller of the old resolver arity must be updated with tenant context.
  The owner boundary is enforced in both Node pre-checks and the SQL commands;
  At the time of this decision the embedded profile still assumed a trusted
  database role; ADR-0040 later adds forced RLS for its tenant-owned tables.
- **Rollback:** Stop mounting the owner-scoped methods and capability route,
  then perform a controlled schema rollback only with an explicit review of
  issued tokens and callers; do not restore acceptance of unscoped tenant
  settlement by accident.
- **Owner:** Node SDK + architecture

## ADR-0041 — AWS S3 adapter ships its runtime SDK

- **Status:** accepted
- **Context:** The built-in S3 artifact adapter lazily imports the three official AWS SDK packages. Keeping them only as optional peers meant a normal `@rhinoq/node` installation could expose `artifacts: 's3'` while failing at runtime until the consumer installed an undocumented extra.
- **Decision:** Make `@aws-sdk/client-s3`, `@aws-sdk/lib-storage` and `@aws-sdk/s3-request-presigner` runtime dependencies of `@rhinoq/node`. Keep the adapter lazy-loaded so non-S3 paths do not initialize AWS code, and keep `archiver`, Cloudinary/custom providers and the lower-level provider injection path optional.
- **Consequences:** A default install gains about 7.7 MiB and 38 transitive packages in the current workspace, but S3 works out of the box and the source/bundle does not duplicate the SDK. Consumers that never use artifacts still pay the install footprint, which is the deliberate trade-off for the documented batteries-included S3 path.
- **Rollback:** Move the three packages back to optional peer dependencies only if install footprint becomes a release blocker; then restore explicit S3 installation instructions and add a separate provider package or install profile before removing the runtime path.
- **Owner:** Node SDK + architecture
## ADR-0042 — Durable Steps extend the Task profile; checkpoints and the Effect Ledger remain separate

- **Status:** accepted
- **Context:** a checkpoint stores an application-controlled cursor for one
  Execution. It cannot atomically persist a completed unit result, fence a
  stale worker, or decide whether user code may be replayed. Creating another
  Node retry store, effect ledger or timeline would split existing authority.
- **Decision:** migration 019 adds tenant-fenced `durable_steps` and
  `durable_step_attempts` to the additive `rhinoq_task` profile. PostgreSQL
  command functions acquire a fenced per-step lease, reuse only a compatible
  completed `(task_id,item_key,step_key,task_version,step_version)` result,
  and atomically write completion or failure. Each mutation advances the
  parent Task version so existing change notification, SSE and Workbench reads
  converge. `ctx.effect()` accepts only an injected facade over the existing
  Go-owned ProviderOperation ledger; unknown, pending and not-applied results
  block Task progress. Checkpoints retain their bounded cursor contract.
- **Consequences:** Node supplies ergonomic declarations and never decides
  lease fencing or an external result. While a Step callback is pending, Node
  renews its currently fenced lease and discards the callback result if renewal
  fails. Flight Recorder and Incident Explanation read the new Step records
  alongside existing Execution and ProviderOperation evidence. Inline Step
  results are capped at 64 KiB; larger results must be artifacts. Per-step
  timeout interruption and automatic durable-await transformation remain later
  runtime work, not P0 claims.
- **Rollback:** stop calling `ctx.step()` and leave the additive records in
  place; no existing checkpoint, Execution or ProviderOperation row changes
  meaning.
- **Owner:** Node SDK + PostgreSQL adapter + product

## ADR-0043 — Tenant-scoped resource leases and terminal user cancellation

- **Status:** accepted
- **Context:** worker-local counters cannot prevent capacity oversubscription
  across processes. A generic `AbortSignal` also cannot prove whether an
  interruption came from a user, a rolling deployment or shutdown; treating all
  aborts as terminal would silently discard retryable work.
- **Decision:** migration 020 adds RLS-protected, tenant-scoped resource pools
  and leases. PostgreSQL serializes admission per pool row, reaps expired
  leases during a later admission, and fences renew/release with
  `(lease_owner, lease_epoch)`. A capacity mismatch for the same tenant/pool
  key fails closed. The Node worker only renews its current lease and discards
  a result after renewal loss. Migration 021 adds fenced durable-Step
  cancellation. The application worker polls authoritative Task state: only
  `cancel_requested` creates terminal `RhinoQUserCancellationError`; generic
  worker interruption becomes retryable `RhinoQWorkerShutdownError`.
- **Consequences:** `createRhinoQApp({ resourcePool, workerId })` is the
  composition boundary for shared admission. Effects are not force-cancelled:
  once a provider outcome may exist, the existing Effect Ledger confirmation
  policy remains authoritative. The first P1 media adapter is the existing
  path/workspace FFmpeg context; no resumable streaming-media claim is made.
- **Rollback:** remove `resources` from affected declarations and stop the
  cancellation monitor or worker. Additive lease/Step records may expire or
  remain as audit evidence; do not delete them without a migration review.
- **Owner:** Node SDK + PostgreSQL adapter + product

## ADR-0044 — Durable worker multipart accepts only replayable local files

- **Status:** accepted
- **Context:** the existing direct-upload session already persists owner/tenant
  scope, provider upload identity, parts, checksum, completion readback and an
  `uncertain` state. A generic worker `AsyncIterable`, however, may be a
  one-time encoder or network response; after a crash a new worker cannot seek
  to a missing part without risking different bytes or a blind replay.
- **Decision:** keep browser uploads on signed parts and extend the existing
  S3-compatible direct provider with a worker-only `uploadPart` operation.
  `context.artifact.filePath()` and output helpers use it only for a non-empty
  replayable file. They derive a stable session ID from Task/Execution/Artifact,
  re-authorize the envelope owner/tenant against the Task, hash the file before
  resume, reconcile provider parts, upload only missing byte ranges, and use
  the existing readback/`uncertain` completion protocol. A changed source fails
  closed. One-shot `stream()` retains backpressure and cancellation but no
  durable-resume claim.
- **Consequences:** no new upload table, completion policy or object-store
  state machine is introduced. A handler must regenerate or retain the same
  file on replay. Existing queued envelopes lacking owner/tenant metadata fall
  back to their existing stream behavior unless they call the new file path,
  in which case they are refused rather than uploaded without authentication.
- **Rollback:** disable the worker `uploadPart` capability or use
  `context.artifact.stream()`; persisted sessions stay readable by the
  existing cleanup and browser-resume paths.
- **Owner:** Node SDK + PostgreSQL adapter + product

## ADR-0045 — One pure compiler result carries plans and structured diagnostics

- **Status:** accepted
- **Context:** the typed application compiler, JSON Plan Inspector, CLI and
  Workbench already consume one canonical plan, but invalid input was reduced
  to ad-hoc thrown strings. Adding stage, linking and deployment adapters on
  top of separate validators would create conflicting readiness decisions.
- **Decision:** compilation remains a read-only projection of the existing
  Task declaration and returns a transport-safe result containing either one
  canonical versioned plan or structured five-part diagnostics. The throwing
  `compileRhinoQPlan()` facade remains for compatibility and delegates to the
  same result. Later normalization, capability-linking and projection phases
  extend this pipeline rather than introducing another declaration language.
  Typed requirements resolve to exactly one namespaced component; the graph
  stores public scalar bindings, permissions and secret references, never
  runtime secret values.
- **Boundary:** compilation cannot open a database, start an adapter, resolve
  secret values or mutate configuration. Diagnostics explain safety but never
  decide Task, lease, retry, Effect or Outcome state; those remain Go and
  authoritative-store responsibilities.
- **Consequences:** CLI, CI, setup, doctor and Workbench can render identical
  error codes and verification commands. Manifest schema v1 and its existing
  fingerprint stay compatible in this slice.
- **Rollback:** callers may ignore result diagnostics and keep using the
  throwing facade without changing the manifest or runtime protocol.
- **Owner:** SDK + DX

## ADR-0046 — Stage is deterministic deployment identity, not authorization

- **Status:** accepted
- **Context:** preview, staging and production deployments need distinct
  resource/evidence namespaces. Reusing tenant or owner identity as a stage
  would blur an authorization boundary, while provider-specific account IDs
  would make the application plan non-portable.
- **Decision:** `defineRhinoQDeployment()` creates a versioned identity from a
  DNS-safe application and stage plus optional public region/target labels.
  Its namespace and fingerprint enter the canonical manifest/plan. The only
  supported tenant boundary remains `single-tenant-process`, matching the Go
  Agent deployment contract. Resource helpers may prefix application-owned
  names from this identity.
- **Boundary:** stage never grants owner, tenant, database or provider access;
  it contains no credential and does not select/provision a cloud provider.
  Authentication and tenant checks remain application/runtime responsibilities.
- **Consequences:** dev, PR, staging and production plans have stable distinct
  identities and diffs without changing Task names or state-machine semantics.
- **Rollback:** omit `deployment` from the application declaration; manifest v1
  readers continue to accept the additive optional field.
- **Owner:** SDK + deployment DX

## ADR-0047 — SST deployment uses compiled intent and adopter-owned factories

- **Status:** accepted
- **Context:** an official SST path can reduce provisioning glue, but importing
  a particular SST version into the core SDK or guessing VPC/database/image
  choices would create dependency churn and unsafe topology assumptions.
- **Decision:** `compileRhinoQSSTDeployment()` translates a canonical plan into
  deterministic worker and optional migration intent. A separate
  `materializeRhinoQSSTDeployment()` receives factories and resource references
  from `sst.config.ts`. All compiled capability links must be supplied before
  either factory runs. Commands and images are explicit adopter inputs.
- **Boundary:** compile performs no cloud action; materialization declares SST
  resources but never executes migrations or handlers. No credential value,
  provider client, Task transition, lease, retry or Effect decision enters the
  adapter. Go/Application/PostgreSQL authority is unchanged.
- **Consequences:** RhinoQ supports SST without a runtime dependency and can
  test the adapter using fake factories. Applications retain full control of
  networking, IAM, database, image build and SST component versions.
- **Rollback:** remove the adapter calls and materialize the same canonical
  plan through another deployment system; no runtime or storage contract
  changes.
- **Owner:** SDK + deployment DX

## ADR-0048 — Plan, diff, compiler doctor and dev share one pure workflow

- **Status:** accepted
- **Context:** separate CLI validation paths can disagree about plan readiness,
  especially after adding deployment and capability graph identity. Database
  doctor checks are valuable but cannot substitute for deterministic compiler
  checks, and dev must not infer missing stage/provider facts.
- **Decision:** `runRhinoQCompilerWorkflow()` is the shared read-only projection
  for validate, diff, compiler doctor and dev preflight. The Node CLI consumes
  it for plan validate/diff, `doctor --plan-from` and `dev --plan-from`. Regular
  doctor continues into its existing PostgreSQL checks unless `--plan-only` is
  explicit. Diff includes Task, deployment and capability graph changes.
- **Boundary:** workflow evaluation opens no database, imports no application
  source, starts no adapter and writes no configuration. Dev only starts its
  existing local surface after preflight. Runtime correctness remains outside
  this projection.
- **Consequences:** CLI, CI and programmatic users receive the same status and
  structured diagnostics for one artifact, while runtime diagnosis remains a
  separate evidenced phase.
- **Rollback:** entry points may call the existing plan projection directly;
  the canonical artifact and runtime protocol do not change.
- **Owner:** SDK + CLI DX
