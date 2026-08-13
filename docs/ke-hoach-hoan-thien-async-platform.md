# Kế hoạch hoàn thiện RhinoQ Async Platform

> Cập nhật: 10/08/2026. Đây là backlog chuẩn duy nhất để tránh quên hoặc quảng
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
| Golden path một mount | Hoàn thành | `app.http()` nối owner API, Task Center, runtime-aware cancellation và Workbench |
| Product shell / route continuity | Hoàn thành cho Node integration | Overview, Tasks, Workbench dùng same-tab navigation; `/overview` redirect tương thích về `/`; SDK nhận navigation path từ host app |
| Overview attention summary | Hoàn thành cho Node integration | Needs attention, Waiting for me, In progress, Completed và Recent dùng Task/waitpoint evidence thật; stuck/verified bucket vẫn chờ contract tương ứng |
| First-run operator access | Hoàn thành cho Node integration | `/operator-login` đổi token thành HttpOnly/SameSite cookie, không nhúng secret trong trang và chỉ bind loopback; production auth vẫn application-owned |
| Owner-scoped SSE cho một Task | Hoàn thành | `GET /tasks/{id}/events`, auth trước stream, `Last-Event-ID`, heartbeat, capacity và test |
| Owner Task inbox SSE | Hoàn thành | `GET /tasks/_events`, bounded page reset, version convergence và test |
| `createUseRhinoTaskLive()` | Hoàn thành | live-first TaskStore, snapshot fallback và reconnect |
| `createUseRhinoTasksLive()` | Hoàn thành | live-first TaskListStore và bounded inbox convergence |
| Polling fallback sau khi SSE mất | Hoàn thành | đọc snapshot authoritative trước khi thử lại stream |
| Task Center realtime | Hoàn thành | skeleton/aria-busy, Live/Polling fallback, Finished/Not finished, completion aria-live notification và test |
| Task explanation dùng chung | Hoàn thành | `taskUIModel().explanation` trả lời trạng thái, progress, retry safety và next action; Task Center/Workbench cùng dùng và có contract test không lộ runtime jargon |
| Owner-facing Task detail | Hoàn thành | `/task-center/{taskId}` có summary, progress, next action và attempt timeline; không đưa runtime identity vào owner UI |
| UI action capability discovery | Hoàn thành | `GET /tasks/_capabilities`; retry/result chỉ hiện khi handler tồn tại, result không resolver fail-closed thay vì lộ reference |
| Task Center search/filter/sort | Hoàn thành | tìm theo type/ID, lọc attention/active/finished, sắp xếp và lưu view trong URL; hoạt động trên bounded owner inbox page |
| Signed realtime subscription token | Chưa có | hiện dùng cookie hoặc application auth header qua Fetch streaming; cần khi cross-origin/public EventSource là use case thật |
| WebSocket | Không ưu tiên | SSE đủ cho server → browser; chỉ mở lại khi có bidirectional/high-frequency demand |
| Realtime logs có redaction | Chưa có | cần log event contract, retention, payload policy và access control |
| Live token streaming cho AI | Chưa có | cần non-authoritative high-frequency channel tách khỏi Task snapshot |
| Realtime artifact notification | Một phần | `hasResult` đi qua Task snapshot; chưa có multi-artifact event/metadata |

## P0 — Interactive Tasks

| Capability | Trạng thái | Definition of Done |
|---|---|---|
| Durable Waitpoint domain/store | Hoàn thành | Go state machine, memory/PostgreSQL store, isolated Node schema v8, version fence và deadline index |
| `waitForInput()` | Hoàn thành | durable re-entry helper, typed parser, không giữ worker/lease mở và phát outbox resume khi resolve |
| `waitForApproval()` | Hoàn thành | generic approval helper kiểm tra boolean contract |
| `waitForWebhook()` | Hoàn thành | webhook helper + capability handler scope token và dùng nonce làm resolution identity |
| Input idempotency | Hoàn thành | resolution ID + SHA-256 payload; duplicate trả cùng record, mismatch fail-closed |
| Signed waitpoint token | Hoàn thành phần primitive | HMAC token scope waitpoint/task/owner/action, TTL, nonce; replay settlement do resolution ID/store bảo vệ |
| `useRhinoTaskInput()` | Hoàn thành | `createUseRhinoTaskInput`, loading/submitting và waiting/resolved/expired/cancelled/error states |
| Owner waitpoint/approval detail | Hoàn thành | bounded owner route + client; Task detail giải thích input/webhook wait và xử lý approval bằng version fence + resolution ID |
| Timeout/escalation | Một phần | DB-time deadline, bounded `WaitpointExpiryScheduler` và escalation hook đã có; Needs Attention/notification policy vẫn application-owned |

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
| Workbench Evidence Rail | Một phần | Go Workbench còn nhiều lens; Node Task Workbench now has the unified Task-profile Flight Recorder |
| Unified API→Task→queue→effect→result view | Một phần | Node Task-profile Flight Recorder now joins Task, Execution, result and waitpoint observations; full effect/provider trace remains |
| Compare attempts | Chưa có | diff contract và UI |
| Latency waterfall | Chưa có | timestamps/clock boundaries và visualization |
| “Vì sao đang chờ?” | Một phần | Node Task Workbench explains waiting/expired waitpoints; provider/effect decision explanation remains |
| “Có an toàn để retry?” | Một phần | Task explanation và Flight Recorder fail-closed/review-before-retry ở Task level; chỉ effect/provider evidence mới có thể xác nhận an toàn |
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

## Thứ tự thực hiện khóa sau vòng competitive review 10/08/2026

1. **Phát hành đúng artifact đã test:** npm beta hiện tại, prebuilt CLI và
   installed-package verification. Một README tốt không cứu được tarball cũ.
2. **Rerun adopter thật:** hai user-visible Tasks, không sửa handler, đo code
   thêm/xóa và chi phí process/datastore/credential. Đây là release evidence,
   không thay bằng benchmark trong repository.
3. **Khép authorization boundary:** nối tenant context tới HTTP surface và đưa
   production operator auth/RBAC ra khỏi trạng thái application convention.
4. **Hoàn thiện Flight Recorder xuyên effect/provider:** một timeline trả lời
   “đã chạy gì, side effect có được xác nhận không, vì sao đang chờ, retry có an
   toàn không”; sau đó mới làm compare-attempt và diagnostic export.
5. **Artifact v1:** identity, metadata, checksum, content type, expiry/refresh
   và lineage. Đây là phần nối async Task với kết quả người dùng thực sự nhận.
6. **Cost ledger chỉ sau demand:** ưu tiên khi design partner có AI/paid-provider
   workload; không xây một billing platform theo suy đoán.

Không chạy đua DAG, durable workflow replay, generic AI token streaming hay
hosted dashboard với Temporal, Restate, Inngest và Trigger.dev. Đó là lợi thế
cốt lõi của họ. RhinoQ phải thắng ở chi phí overlay thấp, Task contract cho
người dùng và bằng chứng outcome sau khi runtime báo hoàn thành.
# Lưu ý trạng thái

Tài liệu này là snapshot kế hoạch ngày 10/08/2026. Các dòng cũ ghi artifact,
multiple artifacts hoặc batch ZIP là "chưa có" đã được thay thế bởi contract
hiện tại: `context.artifact.file/stream/filePath`, `context.output.files/zip`,
metadata/checksum/lineage, owner API và Task Center. Xem trạng thái authoritative
tại [bản đồ capability](./async-task-capabilities.md) và hướng dẫn mới tại
[file/artifact](./artifact-storage.md) hoặc [bản tiếng Việt](./vi/tep-va-artifact.md).
