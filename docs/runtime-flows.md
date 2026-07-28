# Runtime flows

Tài liệu này là bản đồ từ luồng sang package và bảng dữ liệu hiện có. Khi code đổi, sequence tương ứng phải đổi cùng pull request; không vẽ một kiến trúc “mong muốn” khác với implementation.

## 1. Ranh giới tầng

```mermaid
flowchart LR
  subgraph Interfaces
    AG["internal/interfaces/agent"]
    CLI["cmd/rhinoq-*"]
    TS["sdks/typescript"]
  end

  PUB["pkg/rhinoq<br/>public facade"]

  subgraph Core
    APP["internal/application"]
    RUN["internal/runtime"]
    DOM["internal/domain"]
    PORT["internal/ports"]
  end

  subgraph Adapters
    MEM["adapters/memory"]
    PG["adapters/postgres"]
  end

  INF["internal/infrastructure<br/>config · health · migrations"]
  DB[("PostgreSQL")]

  AG --> PUB
  CLI --> PUB
  TS --> AG
  PUB --> APP
  PUB --> RUN
  APP --> DOM
  APP --> PORT
  RUN --> DOM
  RUN --> PORT
  MEM -. "implements" .-> PORT
  PG -. "implements" .-> PORT
  INF --> PG
  PG --> DB
```

Quy tắc review: interface không đọc store; domain không import port/adapter; adapter không gọi ngược application; SDK không chứa state machine, retry engine, lease hoặc Effect Ledger.

## 2. Enqueue có admission và idempotency

```mermaid
sequenceDiagram
  participant Producer
  participant Facade as pkg/rhinoq.Client
  participant Store as JobStore port
  participant PG as PostgreSQL adapter
  participant DB as PostgreSQL

  Producer->>Facade: Enqueue(JobRequest)
  Facade->>Store: Enqueue(EnqueueInput)
  Store->>PG: dynamic dispatch
  PG->>DB: BEGIN + read admission policy
  PG->>DB: bounded pending count
  alt over capacity / reject
    PG-->>Producer: RHINOQ_QUEUE_OVER_CAPACITY
  else accepted
    PG->>DB: INSERT job ON CONFLICT idempotency
    PG->>DB: COMMIT
    PG-->>Producer: jobId
  end
```

Ứng dụng ở ngôn ngữ khác có thể gọi `rhinoq.enqueue()` trong transaction nghiệp vụ. Function vẫn ghi vào cùng `public.rhinoq_jobs`, kiểm allowlist, role, payload, class và priority.

## 3. Claim, fencing và attempt evidence

```mermaid
sequenceDiagram
  participant Worker
  participant Runtime as runtime/worker
  participant Store as JobStore
  participant DB as PostgreSQL

  Worker->>Runtime: free execution slots
  Runtime->>Store: Claim(owner, limit, lease duration)
  Store->>DB: SELECT eligible FOR UPDATE SKIP LOCKED
  Store->>DB: reserve queue rate slots
  Store->>DB: UPDATE jobs SET leased, attempts+1, epoch+1
  Store->>DB: INSERT attempt_event(claimed)
  Store->>DB: COMMIT
  Store-->>Runtime: jobs + owner + epoch + expiry

  loop while handler runs
    Runtime->>Store: RenewLease(owner, epoch)
    Store->>DB: fenced UPDATE using database time
  end

  alt handler succeeded
    Runtime->>Store: Complete(owner, epoch)
    Store->>DB: job=succeeded + event=succeeded atomically
  else handler failed
    Runtime->>Store: Fail(owner, epoch, retry decision)
    Store->>DB: transition job + pending effects=uncertain + terminal event atomically
  else prefetched but never started
    Runtime->>Store: ReleaseLease(owner, epoch)
    Store->>DB: attempts-1 + event=released atomically
  end
```

`attempt_number` là execution budget; một reservation được release có thể trả lại số này. `lease_epoch` không bao giờ giảm và vẫn phân biệt được hai reservation. Timeline public: `Client.AttemptTimeline` hoặc `GET /v1/jobs/{id}/attempts`.

## 4. Effect: accepted khác confirmed

```mermaid
sequenceDiagram
  participant Handler
  participant EffectAPI as application/effect
  participant Ledger as EffectStore
  participant Provider

  Handler->>EffectAPI: BeginEffect(lease, name, key)
  EffectAPI->>Ledger: fenced insert pending
  Ledger-->>Handler: may execute / already confirmed / uncertain
  Handler->>Provider: external request
  Provider-->>Handler: accepted or completed result
  alt confirmation policy satisfied
    Handler->>EffectAPI: ConfirmEffect(lease, evidence)
    EffectAPI->>Ledger: check live fence, then pending → confirmed
  else external signal / verification required
    Handler-->>Handler: request accepted, effect not confirmed
  else result unknown
    Handler->>Ledger: pending → uncertain
  end
```

Ba mốc không được gộp: request accepted → effect confirmed → business outcome achieved.

## 5. Lease expiry và recovery

```mermaid
sequenceDiagram
  participant Reaper as runtime/lease
  participant Jobs as JobStore
  participant Effects as EffectStore
  participant Console
  participant Recovery as application/operations

  Reaper->>Jobs: RequeueExpired()
  Jobs-->>Reaper: expired jobId + epoch
  Jobs->>Jobs: append lease_expired event
  Reaper->>Effects: pending effects at expired epochs → uncertain
  Console->>Recovery: ListAttention()
  Recovery-->>Console: dead / blocked / effect uncertain / outcome mismatch
  Console->>Recovery: Replay(actor, reason)
  Recovery->>Recovery: validate job state and every effect
  alt safe
    Recovery-->>Console: pending job + hash-chained audit
  else unresolved or irreversible effect
    Recovery-->>Console: fail closed
  end
```

## 6. Dữ liệu theo vai trò

| Vai trò | Bảng | Quy tắc |
|---|---|---|
| Hot state | `rhinoq_jobs`, `rhinoq_queue_controls` | update nhỏ, claim index hẹp, mọi execution write có owner+epoch fence |
| Evidence | `rhinoq_attempt_events`, `rhinoq_effects`, `rhinoq_outcomes`, `rhinoq_audit` | timeline theo database time; attempt events không update |
| Delivery | `rhinoq_outbox` | publish ngoài transaction nhưng intent commit atomically |
| SQL boundary | `rhinoq.job_allowlist` | giới hạn job name/role/payload cho transactional enqueue |

Console/read model tương lai chỉ gọi application/public API. Khi history lớn, projection được xây từ evidence; không thêm truy vấn lịch sử nặng vào hot claim path.
