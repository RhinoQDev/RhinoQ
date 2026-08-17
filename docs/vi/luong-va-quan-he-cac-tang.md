# RhinoQ — Luồng và quan hệ giữa các tầng xử lý

Bản đồ đầy đủ của ứng dụng: có những mặt phẳng nào, mỗi tầng gồm package nào, dữ
liệu đi theo đường nào, và **ở đâu có khoá**.

Khác biệt so với các tài liệu sẵn có:

| Tài liệu | Phạm vi |
|---|---|
| [`ARCHITECTURE.md`](../../ARCHITECTURE.md) | Quy tắc và ranh giới — *phải* như thế nào |
| [`docs/runtime-flows.md`](../runtime-flows.md) | Sequence của engine Go |
| **Tài liệu này** | **Cả hai mặt phẳng (Go engine + Node Task profile), quan hệ dữ liệu, và bản đồ khoá** |

Bản đồ khoá ở §8 là phần dùng chung với
[kế hoạch nâng cấp hiệu năng](./nang-cap-hieu-nang-va-bao-mat.md): nó chỉ ra chính
xác từng điểm ngắt mạch nằm ở tầng nào.

---

## 1. Hai mặt phẳng, không phải một

Đây là điều dễ hiểu sai nhất về RhinoQ. Có **hai** đường chạy độc lập, dùng **hai**
lược đồ dữ liệu khác nhau, và chúng gặp nhau ở PostgreSQL chứ không gọi lẫn nhau.

```mermaid
flowchart TB
  subgraph PLANE_A["Mặt phẳng A — Engine Go (authoritative)"]
    direction TB
    A_CMD["cmd/rhinoq · rhinoq-agent · rhinoq-worker"]
    A_PKG["pkg/rhinoq — public facade"]
    A_APP["internal/application"]
    A_DOM["internal/domain"]
    A_RUN["internal/runtime"]
    A_ADP["internal/adapters/postgres"]
    A_CMD --> A_PKG --> A_APP --> A_DOM
    A_PKG --> A_RUN
    A_APP --> A_ADP
    A_RUN --> A_ADP
  end

  subgraph PLANE_B["Mặt phẳng B — Task profile Node/TypeScript"]
    direction TB
    B_APP["Ứng dụng Next.js / NestJS / Express"]
    B_SDK["sdks/node/src/tasks · runtime · bullmq"]
    B_PG["sdks/node/src/postgres — TaskClient"]
    B_FN["Hàm PL/pgSQL rhinoq_task.*"]
    B_APP --> B_SDK --> B_PG --> B_FN
  end

  DB[("PostgreSQL")]
  REDIS[("Redis — BullMQ")]

  A_ADP -->|"schema public: rhinoq_jobs, rhinoq_tasks…"| DB
  B_FN -->|"schema rhinoq_task: tasks, executions…"| DB
  B_SDK -.->|"tuỳ chọn: qua HTTP Gateway"| A_CMD
  B_SDK --> REDIS

  style PLANE_A fill:#0d47a1,color:#fff
  style PLANE_B fill:#1b5e20,color:#fff
```

| | Mặt phẳng A (Go) | Mặt phẳng B (Node) |
|---|---|---|
| Schema | `public.rhinoq_*` | `rhinoq_task.*` |
| Bảng chính | `rhinoq_jobs`, `rhinoq_tasks`, `rhinoq_task_executions` | `rhinoq_task.tasks`, `rhinoq_task.executions` |
| Vận chuyển | PostgreSQL (`SKIP LOCKED`) | BullMQ/Redis, hoặc runtime tuỳ chọn |
| Máy trạng thái ở đâu | `internal/domain` (Go) | Hàm PL/pgSQL trong DB |
| Sở hữu tính đúng đắn | Go | **PostgreSQL** (không phải Node) |
| Điểm vào | `pkg/rhinoq.Client` | `TaskClient` |

**Quy tắc bất biến:** SDK Node không chứa máy trạng thái, không quyết định retry,
không sở hữu Effect Ledger. Khi Node cần một quyết định, nó gọi một hàm PL/pgSQL
hoặc gọi Gateway. Đây là lý do `sdks/node/src/postgres/task-schema.ts` chứa 2,390
dòng SQL: logic nằm ở đó, không nằm trong TypeScript.

---

## 2. Bảy tầng và các package thuộc về từng tầng

```mermaid
flowchart TB
  L1["<b>1 · Contracts</b><br/>internal/contracts — task · notification · diagnostic<br/>proto/rhinoq/v1<br/>sdks/node/src/gateway/types.ts"]
  L2["<b>2 · Domain</b> — thuần, không I/O<br/>admission · attempt · authz · change · correlation<br/>effect · execution · finding · job · notificationdelivery<br/>outcome · provideroperation · recovery · repair · retry<br/>rule · subjectoutcome · task · taskschedule · waitpoint"]
  L3["<b>3 · Application</b> — use case + ranh giới transaction<br/>attention · effect · enqueue · execution · findings<br/>notifications · operations · provideroperations<br/>repairs · retention · rules · tasks · verification"]
  L4["<b>4 · Runtime</b> — cơ chế co giãn được<br/>worker · lease · scheduler · taskscheduler<br/>rulescheduler · queuewatch · supervisor · shutdown"]
  L5["<b>5 · Ports</b> — interface Go<br/>job_store · effect_store · outcome_store · rule_store<br/>finding_store · task_store · recovery_store · outbox…"]
  L6["<b>6 · Adapters</b><br/>adapters/postgres · adapters/memory<br/>adapters/notification · adapters/outbox"]
  L7["<b>7 · Infrastructure</b> — composition root<br/>infrastructure — config · health · migrations<br/>cmd/rhinoq · cmd/rhinoq-agent · cmd/rhinoq-worker"]
  IF["<b>Interfaces</b><br/>interfaces/agent — HTTP Gateway<br/>interfaces/workbench — console cục bộ"]

  IF --> L1
  L1 --> L3
  L3 --> L2
  L3 --> L5
  L4 --> L2
  L4 --> L5
  L6 -. "implements" .-> L5
  L7 --> L6
  L7 --> L3
  L7 --> L4
```

### Quy tắc phụ thuộc — được kiểm tra tự động

`tests/unit/architecture_test.go` là cổng chặn. Thêm ranh giới mới thì thêm luật
vào đó, đừng lách bằng một package tiện ích dùng chung.

```text
interfaces → pkg/rhinoq (facade) → application → domain
                                 └→ runtime     → domain
application, runtime → ports ← adapters
infrastructure → composition root + adapters
```

| Cấm | Vì sao |
|---|---|
| `domain` import port hoặc adapter | Domain phải test được không cần DB |
| `interfaces` đọc thẳng store | Bỏ qua kiểm tra quyền và audit của Application |
| `adapters` import nội bộ `application` | Phụ thuộc vòng; adapter phải thay được |
| SDK chứa máy trạng thái | Sẽ có hai nguồn sự thật, và chúng sẽ lệch nhau |
| Phụ thuộc ngược trực tiếp | Dùng event hoặc port |

---

## 3. Mô hình dữ liệu

### 3.1. Mặt phẳng A — engine Go

```mermaid
erDiagram
  TENANT ||--o{ TASK : "sở hữu"
  TASK ||--o{ EXECUTION : "1:N"
  EXECUTION |o--o| JOB : "0:1"
  EXECUTION ||--o{ PROVIDER_OPERATION : "0:N"
  JOB ||--o{ ATTEMPT : "1:N"
  ATTEMPT ||--o{ EFFECT : "0:N"
  EFFECT ||--o{ OUTCOME : "0:N"
  RULE ||--o{ FINDING : "sinh ra"
  FINDING ||--o{ REPAIR : "đề xuất"
  JOB ||--o{ RECOVERY : "0:N"

  TASK {
    text id PK
    text tenant_id
    text state
    bigint version
  }
  JOB {
    text id PK
    text queue_name
    text state
    timestamptz not_before
    text lease_owner
    bigint fencing_epoch
  }
  ATTEMPT {
    text id PK
    text job_id FK
    int number
    text outcome
  }
  EFFECT {
    text id PK
    text attempt_id FK
    text state
    text idempotency_key
  }
  PROVIDER_OPERATION {
    text id PK
    text state
    jsonb evidence
  }
  RULE {
    text id PK
    int version
    text query
    text status
  }
  FINDING {
    text id PK
    text rule_id FK
    text subject_id
    text state
  }
```

**Bốn máy trạng thái độc lập:** Task, Execution/Job, Effect, Outcome. Chúng không
kế thừa trạng thái của nhau. Đây là điều làm cho *"job chạy xong"* và *"tiền đã
trừ"* là hai câu khác nhau — chính là điểm mấu chốt của sản phẩm.

### 3.2. Mặt phẳng B — Task profile Node

```mermaid
erDiagram
  TASKS ||--o{ EXECUTIONS : "task_id"
  TASKS ||--o{ WAITPOINTS : "task_id"
  TASKS ||--o{ VERIFICATIONS : "task_id"
  TASKS ||--o{ ARTIFACTS : "task_id"
  TASKS ||--o{ NOTIFICATION_OUTBOX : "task_id"
  EXECUTIONS ||--o{ CHECKPOINTS : "execution_id"
  EXECUTIONS ||--o{ ARTIFACT_UPLOAD_SESSIONS : "execution_id"

  TASKS {
    text id PK
    text tenant_id "RLS + DEFAULT current_tenant()"
    text owner_id
    text state
    bigint version "token optimistic concurrency"
    bigint progress_completed
    bigint execution_total "cột đếm do trigger duy trì"
    timestamptz items_settled_at "cổng settle exactly-once"
  }
  EXECUTIONS {
    text id PK
    text task_id FK
    text item_key "định danh item trong fan-out"
    int attempt
    text runtime "bullmq · sqs · custom"
    text external_id
    text state
    bigint version
    timestamptz superseded_at "NULL = attempt đang sống"
    text_array effect_keys "gate idempotency theo item"
  }
```

**Ba bất biến quan trọng nhất:**

1. `tenant_id` có `DEFAULT rhinoq_task.current_tenant()` và được RLS `FORCE` bảo
   vệ. Một predicate bị quên **không** làm rò dữ liệu chéo tenant.
2. `superseded_at IS NULL` xác định attempt đang sống. Unique index từng phần
   `executions_runtime_ref_live_unique` cho phép BullMQ tái sử dụng job id khi
   retry mà vẫn giữ được lịch sử attempt.
3. `items_settled_at` là cổng exactly-once cho tín hiệu "batch xong". Nó *không*
   suy ra từ cột đếm — xem §5.

---

## 4. Luồng A — vòng đời một Job trên engine Go

```mermaid
sequenceDiagram
  autonumber
  actor P as Producer
  participant F as pkg/rhinoq.Client
  participant AP as application/enqueue
  participant D as domain/admission
  participant S as ports.JobStore
  participant PG as adapters/postgres
  participant W as runtime/worker
  participant H as Handler
  participant EL as application/effect

  P->>F: Enqueue(JobRequest)
  F->>AP: EnqueueJob
  AP->>D: kiểm tra admission + idempotency
  D-->>AP: quyết định
  AP->>S: Enqueue(input)
  S->>PG: INSERT rhinoq_jobs + idempotency key
  PG-->>P: JobID (đã commit)

  Note over W,PG: Vòng claim — SKIP LOCKED, lọc theo lane
  W->>PG: Claim(owner, lease, limit, queueNames)
  PG->>PG: SELECT … FOR UPDATE OF j SKIP LOCKED<br/>+ khoá rate control theo thứ tự tên
  PG-->>W: []ClaimedJob (kèm fencing_epoch)

  W->>H: chạy handler
  H->>EL: BeginEffect(idempotencyKey)
  EL->>PG: INSERT effect state=pending
  H->>H: gọi provider bên ngoài
  alt trả về chắc chắn
    H->>EL: ConfirmEffect
  else crash / timeout / không rõ
    Note over EL: giữ nguyên 'uncertain'.<br/>KHÔNG suy ra thành công từ log.
  end
  H-->>W: kết quả
  W->>PG: Complete(fencing token)
  PG->>PG: từ chối nếu epoch đã cũ
```

**Fencing là điểm quan trọng nhất trong sơ đồ này.** Một worker mất lease rồi tỉnh
lại vẫn cầm dữ liệu cũ. `fencing_epoch` làm cho lệnh ghi muộn của nó bị từ chối
tại tầng dữ liệu, chứ không dựa vào việc tiến trình đó tự biết mình đã hết hạn.

### Máy trạng thái Job

```mermaid
stateDiagram-v2
  [*] --> pending
  pending --> claimed : Claim + lease
  claimed --> running
  running --> succeeded
  running --> retry_wait : lỗi tạm thời
  retry_wait --> pending : not_before đã tới
  running --> failed : hết lượt retry
  claimed --> pending : lease hết hạn (reaper)
  running --> uncertain : effect không kết luận được
  uncertain --> succeeded : đối soát read-back
  uncertain --> failed : đối soát read-back
  succeeded --> [*]
  failed --> [*]
```

`uncertain` là trạng thái hạng nhất, không phải một biến thể của `failed`. Nó là
lý do fault-test Stripe cho kết quả đúng: hệ thống ghi nhận *"tôi không biết"* và
đi đối soát, thay vì đoán.

---

## 5. Luồng B — fan-out trên Task profile Node

Đây là đường chạy nóng nhất và cũng là nơi tập trung các điểm ngắt mạch.

```mermaid
sequenceDiagram
  autonumber
  actor U as Ứng dụng
  participant TC as TaskClient
  participant FN as Hàm rhinoq_task.*
  participant T as bảng tasks
  participant E as bảng executions
  participant BR as BullMQTaskBridge
  participant Q as BullMQ / Redis
  participant WK as Worker BullMQ

  U->>TC: createTask({ id, type, ownerId })
  TC->>FN: rhinoq_task.create_task(…)
  FN->>T: INSERT (tenant_id = current_tenant())

  loop mỗi item trong batch
    U->>TC: createTaskExecution(taskId, itemKey)
    TC->>FN: rhinoq_task.create_execution(…)
    FN->>T: 🔒 SELECT … FOR UPDATE (khoá hàng cha)
    FN->>E: INSERT state='pending_dispatch'
    FN->>T: UPDATE version = version + 1
    Note right of T: ⚠️ N2 — mỗi item chạm hàng cha
  end

  U->>Q: Queue.addBulk(items)
  Q-->>BR: biên nhận job id
  BR->>FN: bind_execution(externalId)
  FN->>E: state='dispatched'
  FN->>T: UPDATE version + 1

  Note over BR: Biên nhận không gắn bền được ⇒ 'uncertain',<br/>KHÔNG retry. Đối soát phải gắn trước.

  WK->>WK: chạy handler
  WK->>TC: onceForItem(executionId, effectKey, fn)
  TC->>FN: BEGIN; claim_item_effect(…)
  FN->>T: 🔒 FOR UPDATE — giữ tới COMMIT
  TC->>U: fn(connection) ← code nghiệp vụ chạy ở đây
  Note over T,U: 🔴 N1 — khoá hàng cha bị giữ<br/>suốt thời gian chạy nghiệp vụ.<br/>Toàn bộ fan-out tuần tự hoá.
  TC->>FN: COMMIT

  WK-->>BR: completed / failed
  BR->>FN: transition_execution(→ succeeded)
  FN->>E: UPDATE state
  FN->>T: UPDATE version + 1 (+ trigger đếm)
  BR->>FN: settle_items(taskId)
  FN->>T: đặt items_settled_at nếu mọi item đã kết thúc
  Note right of T: version cố ý KHÔNG tăng —<br/>tránh bão version conflict lúc item cuối về
  BR-->>U: gọi lại onSettled đúng một lần
```

### Tại sao `settle_items` đọc hàng sống thay vì cột đếm

Chi tiết này đáng ghi lại vì nó là một bài học đã trả giá, ghi trong comment của
`TASK_SCHEMA_V7_SQL`:

Cột `execution_*` đếm **mọi attempt từng tồn tại**, kể cả attempt đã bị supersede.
Khi retry biến attempt cũ thành `stalled`, bộ đếm `execution_stalled` không bao giờ
trở về 0 — và batch không bao giờ settle. Nên `settle_items` phải hỏi *"còn item
nào chưa xong không"* trên các hàng `superseded_at IS NULL`, tính theo **item**
chứ không theo **attempt**.

Exactly-once vẫn đến từ `items_settled_at IS NULL`, không đến từ việc đếm.

### Máy trạng thái Execution

```mermaid
stateDiagram-v2
  [*] --> pending_dispatch : create_execution
  pending_dispatch --> dispatched : bind_execution
  pending_dispatch --> cancelled
  pending_dispatch --> running : đã có external_id
  pending_dispatch --> succeeded : đã có external_id
  pending_dispatch --> failed : đã có external_id
  dispatched --> running
  dispatched --> succeeded : runtime không báo "started"
  dispatched --> failed
  dispatched --> stalled
  dispatched --> cancelled
  running --> succeeded
  running --> failed
  running --> stalled
  running --> cancelled
  stalled --> dispatched : retry
  stalled --> failed
  stalled --> cancelled
```

Các cạnh "tắt" (`pending_dispatch → succeeded`, `dispatched → succeeded`) tồn tại
vì lý do thực tế: worker BullMQ nhanh có thể hoàn thành job **trước khi** lệnh
bind kịp commit, và webhook thì không bao giờ báo "started". Từ chối các cạnh này
làm item kẹt vĩnh viễn — và kéo cả batch kẹt theo.

---

## 6. Luồng realtime

```mermaid
flowchart LR
  subgraph NOW["Hiện tại — polling"]
    B1["Trình duyệt"] -->|"EventSource"| S1["taskEventResponse<br/>tasks/sse.ts:20"]
    S1 -->|"SUMMARY_SQL mỗi 1s<br/>cho MỖI kết nối"| D1[("PostgreSQL")]
    S1 -->|"nếu version tăng"| B1
  end

  subgraph NEXT["Sau P0-4 — LISTEN/NOTIFY"]
    F2["Hàm transition"] -->|"pg_notify('rhinoq_task', {id,version})"| D2[("PostgreSQL")]
    D2 -->|"1 connection LISTEN cho cả tiến trình"| H2["Hub trong bộ nhớ"]
    H2 --> B2["N trình duyệt"]
    H2 -.->|"poll 30s làm mạng an toàn"| D2
  end

  style NOW fill:#5d1a1a,color:#fff
  style NEXT fill:#14532d,color:#fff
```

| | Hiện tại | Sau P0-4 |
|---|---|---|
| Truy vấn/giây với 1,000 client | ~1,000 | ~0,03 (một poll an toàn 30 s) |
| Độ trễ nhìn thấy thay đổi | tới 1 s | tới ~vài ms |
| Tải DB theo số client | tuyến tính | hằng số |

Các đường realtime khác dùng chung khuôn: `tasks/websocket.ts` (đã có sẵn hook
"event-driven fast path" chờ được nối vào NOTIFY), `tasks/list-store.ts`,
`workbench/handler.ts`, và `tasks/react.ts` cho phía React.

---

## 7. Luồng khôi phục và đối soát

```mermaid
flowchart TB
  subgraph DETECT["Phát hiện"]
    LR["runtime/lease — reaper<br/>lease hết hạn ⇒ trả job về pending"]
    QW["runtime/queuewatch — watchdog<br/>hàng đợi tồn đọng / đói"]
    RS["runtime/rulescheduler<br/>chạy Rule nghiệp vụ định kỳ"]
    TS["runtime/taskscheduler<br/>task theo lịch"]
    WE["expire_waitpoints(limit)<br/>waitpoint quá hạn"]
    RC["tasks/reconciler.ts<br/>lọc task kẹt"]
  end

  subgraph DECIDE["Quyết định — Domain"]
    RT["domain/retry — phân loại lỗi"]
    RV["domain/recovery — đủ điều kiện resume?"]
    RP["domain/repair — RepairPlan"]
    FD["domain/finding — vòng đời Finding"]
  end

  subgraph ACT["Hành động — Application"]
    AR["application/repairs"]
    AA["application/attention"]
    AN["application/notifications"]
  end

  LR --> RT --> AR
  QW --> AA
  RS --> FD --> RP --> AR
  TS --> RT
  WE --> RV
  RC --> AA
  AA --> AN
  AR -->|"chỉ qua use case Application,<br/>không bao giờ ghi thẳng store"| DB[("PostgreSQL")]
  AN -->|"outbox có ledger giao nhận"| DB
```

**Ràng buộc bất biến:** control plane (Workbench, CLI, Gateway) *quan sát* và *đề
nghị hành động*. Nó không tự ghi vào store. Mọi hành động sửa chữa đi qua use case
của Application, kèm actor, lý do và dữ liệu audit. Đây là điều làm cho một thao
tác sửa lỗi thủ công vẫn để lại bằng chứng.

---

## 8. Bản đồ khoá — nơi hệ thống thực sự tuần tự hoá

Đây là bảng cần đọc trước khi thay đổi bất cứ thứ gì trên đường nóng.

```mermaid
flowchart TB
  subgraph HOT["🔴 Hàng nóng — tranh chấp cao"]
    TR["rhinoq_task.tasks — MỘT hàng cho mỗi Task"]
  end

  CE["create_execution"] -->|"FOR UPDATE"| TR
  CI["claim_item_effect"] -->|"FOR UPDATE — giữ suốt callback"| TR
  BE["bind_execution"] -->|"UPDATE version"| TR
  TE["transition_execution"] -->|"UPDATE version"| TR
  AE["attach_execution_result"] -->|"UPDATE version"| TR
  RE["retry_execution"] -->|"UPDATE version"| TR
  TG["trigger update_execution_counts<br/>FOR EACH ROW"] -->|"UPDATE các cột đếm"| TR
  RP["report_progress"] -->|"FOR UPDATE"| TR
  TT["transition_task"] -->|"FOR UPDATE"| TR

  style HOT fill:#5d1a1a,color:#fff
  style TR fill:#7f1d1d,color:#fff
```

| Khoá | Ở đâu | Phạm vi | Giữ bao lâu | Rủi ro |
|---|---|---|---|---|
| `tasks … FOR UPDATE` | `claim_item_effect` | hàng Task cha | **suốt callback nghiệp vụ** | 🔴 tuần tự hoá toàn fan-out — N1 |
| `UPDATE tasks SET version+1` | 6 hàm transition + trigger | hàng Task cha | tới hết transaction | 🔴 hot row + bloat — N2 |
| `pg_advisory_xact_lock(commandID)` | `task_store.go:168` | theo lệnh | tới hết transaction | 🟢 đúng phạm vi |
| `pg_advisory_xact_lock(findingKey)` | `finding_store.go:244` | theo finding | tới hết transaction | 🟢 đúng phạm vi |
| `FOR UPDATE OF j SKIP LOCKED` | `job_store.go:418` | hàng job ứng viên | ngắn | 🟢 đúng mẫu claim |
| `FOR UPDATE` rate controls | `job_store.go:432` | hàng theo lane, sắp thứ tự tên | ngắn | 🟢 thứ tự khoá tránh deadlock |
| `pg_advisory_lock(migration)` | `migrations/runner.go:144` | toàn cục | suốt migration | 🟢 đúng, có chủ đích |
| Projector lease | `postgres/projector-lease.ts` | theo scope | có gia hạn | 🟢 chỉ một writer ghi tiến độ |
| `sync.Mutex` rate limiter | `agent/server.go:508` | **toàn tiến trình** | mỗi request | 🟡 điểm tuần tự hoá — N10 |

**Cách đọc bảng:** mọi thứ màu xanh đều đúng mẫu và có thứ tự khoá nhất quán. Hai
hàng đỏ đều trỏ về **một** hàng dữ liệu duy nhất — `rhinoq_task.tasks` của Task
đang chạy. Đó là điểm ngắt mạch của toàn hệ thống, và nó nằm ở tầng SQL, không nằm
ở tầng ứng dụng.

---

## 9. Bảng tra: tầng → package → bảng dữ liệu

| Tầng | Package Go | Module Node | Bảng chạm tới |
|---|---|---|---|
| Contracts | `internal/contracts/*`, `proto/rhinoq/v1` | `gateway/types.ts` | — |
| Domain | `internal/domain/*` (20 package) | — (cố ý trống) | — |
| Application | `internal/application/*` (13 package) | — | qua ports |
| Runtime | `internal/runtime/*` (8 package) | `runtime/`, `bullmq/` | qua ports |
| Ports | `internal/ports/*` (16 interface) | — | — |
| Adapters | `adapters/{postgres,memory,notification,outbox}` | `postgres/task-client.ts` | trực tiếp |
| Infrastructure | `infrastructure/{config,health,migrations}` | `cli/database-config.ts` | migration |
| Interfaces | `interfaces/{agent,workbench}` | `tasks/http.ts`, `workbench/` | không bao giờ trực tiếp |

---

## 10. Danh sách kiểm tra khi review

Trước khi merge một thay đổi chạm đường nóng:

- [ ] Có thêm lệnh ghi nào vào `rhinoq_task.tasks` trên mỗi item không? *(N2)*
- [ ] Có giữ khoá qua một lời gọi mạng nào không? *(N1)*
- [ ] Lệnh ghi có trả về snapshot đầy đủ không? Nếu có, vì sao cần? *(N3)*
- [ ] Truy vấn mới có nằm trong vòng lặp poll không? *(N4, N7)*
- [ ] Có thêm pool PostgreSQL nào không? Đã đặt `MaxOpenConns` chưa? *(N5)*
- [ ] Đường đọc mới có predicate tenant **và** dựa được vào RLS không? *(N6, S1)*
- [ ] Có `lock_timeout` cho transaction có thể phải chờ không? *(N8)*
- [ ] `tests/unit/architecture_test.go` còn xanh không?
- [ ] Nếu tuyên bố một con số hiệu năng: script tái lập đã nằm trong repo chưa?

---

## Xem thêm

- [Kế hoạch nâng cấp hiệu năng và bảo mật](./nang-cap-hieu-nang-va-bao-mat.md) —
  phân tích chi tiết từng điểm ngắt mạch và cách sửa.
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) · [`docs/runtime-flows.md`](../runtime-flows.md)
  · [`docs/failure-semantics.md`](../failure-semantics.md) · [`docs/tenancy.md`](../tenancy.md)
