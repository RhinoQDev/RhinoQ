# Kế hoạch hoàn thiện RhinoQ Async Platform

> Cập nhật: 09/08/2026. Đây là backlog chuẩn duy nhất để tránh quên hoặc quảng
> bá một capability chưa có code và test. Mỗi mục chỉ chuyển sang **Hoàn thành**
> khi public API, UI cần thiết, test và tài liệu cùng tồn tại.

## Quy ước trạng thái

- **Hoàn thành:** dùng được qua public contract và có test.
- **Một phần:** có primitive nhưng adopter vẫn phải tự xây phần lớn vertical slice.
- **Đang làm:** thuộc change hiện tại.
- **Chưa có:** chưa có public capability.
- **Không ưu tiên:** có chủ ý chưa xây vì không phù hợp product boundary.

## P0 — Giá trị người dùng nhìn thấy ngay

| Capability | Trạng thái | Bằng chứng / phần còn thiếu |
|---|---|---|
| Owner-scoped SSE cho một Task | Hoàn thành | `GET /tasks/{id}/events`, auth trước stream, `Last-Event-ID`, heartbeat, capacity và test |
| Owner Task inbox SSE | Hoàn thành | `GET /tasks/_events`, bounded page reset, version convergence và test |
| `createUseRhinoTaskLive()` | Hoàn thành | live-first TaskStore, snapshot fallback và reconnect |
| `createUseRhinoTasksLive()` | Hoàn thành | live-first TaskListStore và bounded inbox convergence |
| Polling fallback sau khi SSE mất | Hoàn thành | đọc snapshot authoritative trước khi thử lại stream |
| Task Center realtime | Hoàn thành | skeleton/aria-busy, Live/Polling fallback, Finished/Not finished, completion aria-live notification và test |
| Signed realtime subscription token | Chưa có | hiện dùng cookie hoặc application auth header qua Fetch streaming; cần khi cross-origin/public EventSource là use case thật |
| WebSocket | Không ưu tiên | SSE đủ cho server → browser; chỉ mở lại khi có bidirectional/high-frequency demand |
| Realtime logs có redaction | Chưa có | cần log event contract, retention, payload policy và access control |
| Live token streaming cho AI | Chưa có | cần non-authoritative high-frequency channel tách khỏi Task snapshot |
| Realtime artifact notification | Một phần | `hasResult` đi qua Task snapshot; chưa có multi-artifact event/metadata |

## P0 — Interactive Tasks

| Capability | Trạng thái | Definition of Done |
|---|---|---|
| Durable Waitpoint domain/store | Hoàn thành | Go state machine, memory/PostgreSQL store, isolated Node schema v7, version fence và deadline index |
| `waitForInput()` | Hoàn thành | durable re-entry helper, typed parser, không giữ worker/lease mở và phát outbox resume khi resolve |
| `waitForApproval()` | Hoàn thành | generic approval helper kiểm tra boolean contract |
| `waitForWebhook()` | Hoàn thành | webhook helper + capability handler scope token và dùng nonce làm resolution identity |
| Input idempotency | Hoàn thành | resolution ID + SHA-256 payload; duplicate trả cùng record, mismatch fail-closed |
| Signed waitpoint token | Hoàn thành phần primitive | HMAC token scope waitpoint/task/owner/action, TTL, nonce; replay settlement do resolution ID/store bảo vệ |
| `useRhinoTaskInput()` | Hoàn thành | `createUseRhinoTaskInput`, loading/submitting và waiting/resolved/expired/cancelled/error states |
| Timeout/escalation | Chưa có | DB-time deadline, bounded scheduler, Needs Attention/notification |

## P1 — Batch và Task Group

| Capability | Trạng thái | Phần còn thiếu |
|---|---|---|
| Fan-out Task/Execution/itemKey | Hoàn thành | memory/PostgreSQL/BullMQ bridge và benchmark |
| Per-item attempts/results/failure | Hoàn thành | pagination và partial-failure UI model |
| `dispatchBatch(items)` | Hoàn thành | alias trên durable reserve-before-enqueue, stable item/job identity và `maxBatchSize` admission |
| `retryFailed()` | Hoàn thành phần contract | stable child/execution identity và tuần tự hóa aggregate version qua callback transaction/outbox authoritative; application vẫn sở hữu payload/queue mapping |
| `cancelPending()` | Hoàn thành phần contract | chỉ chọn pending/dispatched, bounded fail-closed callback; không đụng active effect |
| TaskGroup domain/parent-child view | Hoàn thành | derived aggregate trên Task + latest Execution per item, counts/complete/partial failure |
| Failed-item export | Hoàn thành | owner-authenticated CSV/JSON download route + browser Blob helper |
| Batch ZIP/manifest | Một phần | manifest ghép per-item result đã có; ZIP artifact/retention còn thiếu |
| Per-batch concurrency | Một phần | bounded group actions + bridge dispatch concurrency; chưa có persisted per-batch fairness override |

## P1 — Cost và resource guardrails

| Capability | Trạng thái | Phần còn thiếu |
|---|---|---|
| Queue capacity/priority/rate/concurrency | Hoàn thành | technical capacity control |
| Task cost ledger | Chưa có | unit, currency, provider/model, attempt và billable operation identity |
| AI token/GPU/provider usage | Chưa có | normalized usage events và adapters |
| User/tenant/project budget | Chưa có | admission decision + reset window + RBAC |
| Estimate trước dispatch | Chưa có | estimator contract và confidence/evidence |
| Approval khi vượt budget | Chưa có | phụ thuộc Durable Waitpoint |
| Cost breakdown UI | Chưa có | Task/attempt/provider views |
| Duplicate retry billing protection | Chưa có | business operation identity nối cost ledger |

## P1 — Result và Artifact Platform

| Capability | Trạng thái | Phần còn thiếu |
|---|---|---|
| Authorized single result | Hoàn thành | signed resolver/download helper/expired UI state |
| Per-execution result | Hoàn thành | owner-scoped pagination |
| Multiple artifacts | Chưa có | artifact identity, metadata và ordering |
| Metadata/checksum/content type | Chưa có | versioned Artifact contract |
| Preview/thumbnail | Chưa có | authorized rendition resolver |
| Artifact lineage | Chưa có | producer Execution/effect/attempt correlation |
| Refresh expired URL | Chưa có | browser helper + resolver semantics |
| Batch download/ZIP manifest | Chưa có | streaming/async packaging Task |
| Retention/regenerate policy | Chưa có | policy + Needs Attention khi artifact hết hạn |

## P2 — Async Flight Recorder

| Capability | Trạng thái | Phần còn thiếu |
|---|---|---|
| Attempt/effect/outcome/finding/audit data | Hoàn thành | append-only evidence đã có |
| Workbench Evidence Rail | Hoàn thành | hiện là nhiều lens, chưa phải unified trace |
| Unified API→Task→queue→effect→result view | Chưa có | normalized timeline projection |
| Compare attempts | Chưa có | diff contract và UI |
| Latency waterfall | Chưa có | timestamps/clock boundaries và visualization |
| “Vì sao đang chờ?” | Chưa có | deterministic attention/decision explanation |
| “Có an toàn để retry?” | Một phần | guardrails có; chưa có public decision report thống nhất |
| Diagnostic bundle export | Chưa có | redaction + bounded archive |
| OpenTelemetry correlation end-to-end | Một phần | IDs/metrics có; trace propagation chưa hoàn chỉnh |

## P2 — Verifiable Tasks hardening

| Capability | Trạng thái | Phần còn thiếu |
|---|---|---|
| ProviderOperation/effectively-exactly-once report | Hoàn thành | per-effect, không claim toàn hệ thống |
| Bounded verifier reconciliation | Hoàn thành | mutation callback không xuất hiện trong sweep |
| Provider marketplace | Chưa có | chỉ làm sau nhu cầu lặp lại từ design partners |
| Provider webhook auth adapters | Chưa có | Stripe/storage/etc. theo provider |
| Confirmation deadline UI | Một phần | unresolved operation query có; deadline/escalation UX chưa đủ |
| Tenant-wide authorization đồng đều | Chưa có | release gate |
| Production evidence nhiều adopter | Chưa có | tối thiểu ba design-partner pilots |

## Thứ tự thực hiện khóa

1. Hoàn thiện Task Center realtime UX.
2. Durable Waitpoint/Input vertical slice.
3. Task Group/Batch actions.
4. Artifact v1.
5. Cost ledger và budget guardrails.
6. Unified Async Flight Recorder.

Không bắt đầu WebSocket, DAG engine hay provider marketplace trước khi hạng mục
đang làm đạt Definition of Done và toàn bộ regression pass.
