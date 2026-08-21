# Kế hoạch liên kết dữ liệu và tính năng bứt phá của RhinoQ

> Trạng thái: đề xuất để triển khai sau beta. Đây là backlog sản phẩm và tích
> hợp, không phải claim capability đã phát hành.

Tài liệu này chuyển các ý tưởng phân tích thành một kế hoạch có thể giao việc.
Mục tiêu là làm cho người dùng thấy giá trị ngay từ lần đầu, đồng thời mở rộng
đúng lợi thế của RhinoQ: nối trạng thái kỹ thuật, external effect và business
outcome thành bằng chứng có thể kiểm tra.

## 1. Kết luận ngắn

Đòn bẩy lớn nhất không phải thêm một queue, worker hay dashboard nữa. RhinoQ
đã thu thập phần dữ liệu khó nhất; phần còn thiếu là nối chúng thành một câu
chuyện mà người dùng có thể tìm, hiểu và hành động trong vài bước:

```text
request/correlation
  -> Task intent
  -> attempt và thời gian queue đã quan sát
  -> effect + trạng thái confirmed/not-happened/uncertain
  -> rule/verifier và finding
  -> recovery có phê duyệt
  -> business outcome
```

Ưu tiên số một là **Causal Task Timeline + một ô tìm kiếm hợp nhất**. Đây là
surface có thể biến nhiều subsystem đang rời nhau thành một trải nghiệm duy
nhất. Sau đó mới thêm các lớp tạo khác biệt mà các queue thông thường không có:

1. Kinh tế của correctness: biết một retry mù có thể tốn bao nhiêu tiền.
2. Regression theo handler/deploy version: biết bản deploy nào làm outcome xấu đi.
3. Evidence Receipt chia sẻ được: support/audit chứng minh effect đã xảy ra.
4. Owner self-service có evidence-gate: người dùng cuối được hành động an toàn.
5. Risk window theo dữ liệu đo được: cảnh báo nguy cơ trễ mà không bịa ETA.

Các con số trong tài liệu này là tên metric hoặc mục tiêu cần đo, không phải
cam kết throughput, latency, reliability, tiết kiệm chi phí hay SLA.

## 2. Phân loại chính xác: đã có, đang nối, và hoàn toàn mới

### 2.1. Không xây lại từ đầu

Các mảnh sau đã tồn tại trong repository hoặc đã có kế hoạch riêng. Công việc
đúng là nối chúng thành flow, thêm test và đưa ra UI/CLI rõ ràng; không tạo một
implementation thứ hai:

| Mảnh hiện có | Bằng chứng trong repo | Cách dùng trong kế hoạch này |
| --- | --- | --- |
| Flight Recorder | `sdks/node/src/tasks/flight-recorder.ts`, `docs/async-flight-recorder.md` | nguồn event cho Causal Timeline |
| Incident explanation | `sdks/node/src/tasks/incident-explanation.ts` | phần “vì sao đang uncertain?” và next action |
| Evidence Passport | `sdks/node/src/tasks/evidence-passport.ts` | receipt, cost snapshot và version comparison |
| Task Center/Workbench | `sdks/node/src/tasks/task-center.ts`, `docs/vi/ke-hoach-tong-the-first-value-readme-dx.md` | một shell hiển thị search, trace và action |
| Progress, attempt, effect, verification | các contract trong `sdks/node/src/gateway/types.ts` | không tạo state machine mới |
| Plan Inspector và Rule Console roadmap | `sdks/node/src/tasks/plan-inspector.ts`, kế hoạch First Value | dùng làm preflight, không thay bằng SQL tự do |
| Reconciler và recovery guardrail | `sdks/node/src/tasks/reconciler.ts`, `sdks/node/src/recovery/guarded.ts` | chỉ expose action khi evidence cho phép |
| Notify/webhook ký HMAC | `sdks/node/src/notify/sender.ts` | một outbound contract chung, không viết adapter Jira/PagerDuty riêng |
| `dev`, `up`, `connect`, `add task`, `doctor` | README và test first-value | kết thúc onboarding bằng trace thật của fixture |
| traceId/spanId dạng correlation | `docs/async-flight-recorder.md` | nối request với Task; không giả làm OTel exporter |

Các mục scan, typed Rule builder/introspect, `fix --dry-run`, spike pause,
OpenTelemetry, GitHub Action, Console hợp nhất, Rule Console, Safe Bulk Actions
và saved views đã được đề cập trong các kế hoạch trước. Chúng vẫn cần được
hoàn thiện/verify theo roadmap tương ứng, nhưng không được tính là “tính năng
bứt phá mới” trong tài liệu này.

### 2.2. Khoảng trống cần nối

Hiện người dùng phải tự biết record nào thuộc subsystem nào. Chưa có một
resolver chung cho correlation/task/finding/owner, chưa có timeline causal duy
nhất, và chưa có một nút hành động giải thích được từ business outcome quay về
technical evidence.

### 2.3. Nhóm hoàn toàn mới của kế hoạch này

Các đề xuất dưới đây không chỉ đổi layout. Chúng thêm một chiều giá trị mà
queue phổ thông không cung cấp: tiền, phiên bản triển khai, bằng chứng chia sẻ,
rủi ro theo phân phối và hành động an toàn cho end-user.

### 2.4. Phần đã có trong roadmap nhưng vẫn phải hoàn thiện

Bảng này giữ lại các ý tưởng trong phân tích gốc để không bị thất lạc, nhưng
đánh dấu đúng bản chất của chúng: đây là completion backlog, không phải moat mới.

| Hạng mục | Trạng thái cần giữ | Việc cần làm tiếp | Điều kiện hoàn thành |
| --- | --- | --- | --- |
| `rhinoq scan` read-only | `adopt --scan` và Integration Eraser là nền hiện có | quyết định giữ tên hiện tại hay thêm alias `scan`; sinh 2–3 Rule có confidence, file/line evidence và comment p99 nếu thật sự đo được | không đổi queue, không ghi DB, preview mặc định, không gọi bất thường thành lỗi |
| Typed Rule builder + `introspect` | Rule/plan metadata đã có hướng compiler | sinh type/field từ schema được cấp quyền, tạo Rule thứ hai bằng typed API | không còn object string mơ hồ; test compile và unknown-field fail-closed |
| `fix --dry-run` / auto-enqueue | guarded recovery, approval và idempotency đã có mảnh nền | nối preview với Safe/Uncertain/Blocked, `maxPerRun`, circuit breaker và handler registry | execute chỉ sau approval; post-check bắt buộc; unknown không retry |
| Spike detection → pause | notify/webhook và operational config đã có | thêm tín hiệu spike từ rate/error/uncertain và stage config transaction | pause là policy có phê duyệt, có rollback, không tự đoán ngưỡng |
| OTel correlation | `traceId`/`spanId` hiện là correlation-only | thêm propagator/export adapter tùy chọn, liên kết request span với Task trace | không biến correlation thành evidence; collector là boundary ngoài Domain |
| GitHub Action `explain` | chưa phải capability runtime | action read-only chạy plan/rule/index guard, comment CREATE INDEX có evidence | PR fail trước deploy khi guard không đạt; không chạy SQL mutation |
| Console hợp nhất | Task Center/Workbench có; Console shell là roadmap | một cửa vào search/Queues/Findings, advanced surface giữ nguyên | quickstart một màn hình, không làm mất owner/operator boundary |
| Incident one-click | `incident-explanation` đã có logic | nút “Vì sao task này uncertain?” mở explanation + timeline + next action | action availability khớp capability; không diễn giải vượt evidence |
| Saved views/share filters | URL lens/filter đã có một phần | mở rộng cho trace/finding, token opaque và scope | URL không lộ secret/PII; view có version và owner scope |
| Rule Console | read-only Rule explain/test là hướng đã chốt | test subject, reason, bounded sample, history, open count, last run, preview `Run now` | không cho SQL tùy ý; sample/limit/authorization được kiểm thử |
| Safe Bulk Actions | guard/recovery primitives đã có, bulk UX còn thiếu | preview impact, phân nhóm, approval, handler registry, post-verify | không có bulk retry mù; audit đủ actor/command/version |

Những mục này nên được hoàn tất trước hoặc song song với moat mới, nhưng khi
viết website/README phải ghi đúng là “đang hoàn thiện” cho tới khi có code, test
và evidence.

## 3. P0 — Causal Task Timeline và Universal Search

### 3.1. Mục tiêu người dùng

Người xử lý sự cố chỉ cần dán bất kỳ định danh nào mình có. RhinoQ phải đưa họ
đến cùng một Task và cho thấy chuỗi nguyên nhân–kết quả, thay vì bắt họ mở log,
Workbench và Rule riêng.

### 3.2. Contract đề xuất

Thêm một read-only projection versioned, ví dụ:

```ts
type RhinoQTraceQuery = {
  query: string; // task, correlation, finding, owner contact hoặc provider ref
  ownerId?: string;
  tenantId?: string;
  limit?: number;
};

type CausalTaskTimeline = {
  schemaVersion: 1;
  taskId: string;
  correlationId?: string;
  nodes: Array<{
    id: string;
    kind: 'request' | 'intent' | 'queue' | 'attempt' | 'effect'
      | 'verification' | 'finding' | 'recovery' | 'outcome';
    observedAt?: string;
    state?: string;
    label: string;
    evidenceRefs: string[];
  }>;
  edges: Array<{ from: string; to: string; relation: string }>;
  attention: 'none' | 'uncertain' | 'failed' | 'needs_decision';
};
```

Nguyên tắc:

- Chỉ hiển thị timestamp có trong record; thiếu thời gian queue thì ghi “chưa
  có dữ liệu”, không suy ra từ `createdAt`.
- `uncertain` là trạng thái đầu tiên-class; tuyệt đối không biến thành success
  hoặc cho phép retry mù.
- Mỗi node trỏ về evidence bounded; không nhúng raw log, secret hoặc provider
  credential vào owner view.
- Search phải tôn trọng owner/tenant boundary. Email/số điện thoại được hash,
  redact hoặc tìm qua adapter ứng dụng; không lưu PII mới chỉ để search.

### 3.3. Surface cần giao

| Surface | Hành vi |
| --- | --- |
| Workbench/Console | search ở header; kết quả phân nhóm Task/Finding/Effect; mở trace bằng một click |
| Task Center | nút “Vì sao task này uncertain?” chỉ hiện khi task có attention |
| CLI | `rhinoq trace <query> --json` và chế độ terminal readable; mặc định read-only |
| API | `GET /tasks/trace?q=...` với pagination, owner scope và schema version |
| URL | trace/finding filter được share bằng URL đã ký hoặc opaque token; không lộ PII |

### 3.4. Acceptance criteria

- Một fixture có attempt thất bại, effect uncertain, rule mismatch và recovery
  phải render thành cùng một causal chain trong UI, CLI và JSON.
- Cùng một query chỉ trả record mà principal được phép đọc.
- Search không cần biết trước loại ID; kết quả nói rõ nó khớp ở trường nào.
- Không có evidence thì UI nói “không có dữ liệu”, không tạo ETA, queue time hay
  nguyên nhân tưởng tượng.
- Replay cùng snapshot/evidence tạo cùng projection.

## 4. P1 — Kinh tế của correctness (Effect Cost Ledger)

### 4.1. Vì sao đây là tính năng bứt phá

RhinoQ đã biết effect nào được reserve, effect nào uncertain và attempt nào
đã lặp lại. Hiện “cost” chủ yếu là plan/EXPLAIN hoặc budget kỹ thuật; chưa có
chiều kinh tế. Khi thêm một policy đơn giá do application khai báo, quyết định
recovery trở nên dễ hiểu với developer, operator và người ra quyết định:

```text
47 finding cần xem lại
= 44 provider call đã đo
= 3 effect uncertain
= chi phí ước tính theo policy của ứng dụng
```

Đây là ước tính theo evidence, không phải hóa đơn cloud tự động và không được
đặt giá mặc định khi application chưa khai báo.

### 4.2. Contract và tích hợp

Thêm port application-owned, không để Domain biết billing provider:

```ts
type EffectCostPolicy = {
  version: string;
  currency: string;
  rules: Array<{
    provider: string;
    operation: string;
    unitCostMinor: number;
    unit: 'call' | 'item' | 'byte' | 'minute';
  }>;
};

type EffectCostSnapshot = {
  policyVersion: string;
  measuredUnits: number;
  estimatedMinor: number;
  currency: string;
  confidence: 'measured' | 'policy_estimate' | 'unavailable';
};
```

Tích hợp nên làm:

- `CostPolicyProvider` để application lấy policy từ config/billing export của
  họ; RhinoQ không gọi thẳng AWS/GCP/Azure Billing.
- Plan Inspector hiển thị số call/item/byte dự kiến trước bulk action nếu có
  policy; nếu không có thì ghi “chưa khai báo cost policy”.
- `fix --dry-run` phân nhóm Safe/Uncertain/Blocked và thêm cost impact; execute
  phải giữ `maxPerRun`, idempotency và circuit breaker.
- Digest/webhook chỉ gửi cost snapshot đã redact, kèm policy version.

### 4.3. Acceptance criteria

- Không có policy thì không có số tiền được đoán.
- Lost response không làm cost ledger đếm effect thứ hai.
- Preview và receipt ghi cùng policy version; thay policy không sửa lịch sử.
- Bulk recovery dừng khi cost/rate spike vượt hard cap và tạo finding cần duyệt.

## 5. P1 — Regression theo handler/deploy version

Evidence Passport đã có chỗ ghi handler build/version/digest, nhưng chưa trả lời
“bản deploy nào làm tỷ lệ uncertain tăng?”. Tính năng này nối chất lượng outcome
với phiên bản code của adopter.

### 5.1. Dữ liệu cần nối

- `handlerVersion`, `handlerDigest`, `deploymentId`, `deployedAt` từ application
  manifest hoặc resource attributes.
- outcome/verification status, effect state, retry count và task type.
- correlation tới commit/deploy URL nếu application cung cấp; RhinoQ không tự
  gọi Git provider để đoán.

### 5.2. Surface và cảnh báo

- Workbench: “uncertain rate theo handler version”, so sánh attempt trước/sau.
- Rule/notify: finding `outcome_regression` khi có đủ sample và baseline.
- Digest: link tới build/deploy evidence, sample size và khoảng thời gian quan
  sát; không kết luận nhân quả nếu sample chưa đủ.
- CLI: `rhinoq explain regression --task-type report.export --since ...` là
  read-only và in rõ thiếu dữ liệu nào.

### 5.3. Acceptance criteria

- Không so sánh hai version nếu thiếu cùng một task type, verifier và khoảng
  quan sát tương đương.
- Không tạo alert từ một task đơn lẻ; ngưỡng sample/config phải explicit.
- Không dùng từ “regression do commit X” nếu chỉ có correlation; dùng “tương
  quan với version X” và link evidence.

## 6. P1 — Evidence Receipt cho support và audit

Passport hiện hữu ích cho operator nhưng chưa phải một sản phẩm chia sẻ được.
Thêm một receipt một-link, bounded và đã redact để support trả lời tranh chấp:

```text
Customer hỏi: “Refund đã xảy ra chưa?”
Support mở receipt:
  thời điểm observed -> provider operation -> readback confirmation
  -> verifier/rule -> outcome
```

### 6.1. Contract

- `POST /tasks/:id/evidence-receipt` tạo token opaque, thời hạn và scope.
- `GET /evidence-receipts/:token` chỉ trả field đã allow-list.
- Receipt ghi schema version, generatedAt, evidence refs, redaction policy và
  verification status.
- Chữ ký/WORM là phase sau; phase đầu không được quảng bá receipt là chứng cứ
  pháp lý.

### 6.2. Guardrail

- Owner/support chỉ thấy task thuộc scope được cấp; operator token không được
  nhúng vào URL.
- Secret, raw request/response, email và số điện thoại phải redact.
- `unknown` và `uncertain` phải giữ nguyên; receipt không được viết thành
  “đã thành công”.

## 7. P1 — Owner self-service có evidence-gate

Operator-only recovery giải quyết an toàn, nhưng end-user mới là người cảm nhận
tiện lợi. Mở một phần nhỏ sang owner:

- Nút “Retry an toàn” chỉ xuất hiện khi reconciliation chứng minh
  `not_happened`; nếu `uncertain` thì chỉ có “Kiểm tra lại”.
- “Báo tôi khi xong” và “Kết quả đã sẵn sàng” qua outbound notification contract
  chung; không tạo N integration native.
- Kết quả một phần chỉ hiển thị khi artifact/evidence policy cho phép.
- Waitpoint cần quyết định thì owner nhận thông báo có link về đúng Task.

Tích hợp đề xuất:

- Adapter email/push của application nhận `NotificationMessage` đã ký.
- Frontend dùng cùng owner API, SSE/polling và authorization hiện có.
- Audit record ghi actor, command id, expected version và bằng chứng đã dùng để
  bật action.

## 8. P2 — Risk window thay cho ETA bịa

RhinoQ có progress history, queue lag và service time nhưng không nên tự đoán
“còn 37 giây”. Thay vào đó, khi application khai báo SLO, hiển thị rủi ro theo
phân phối đo được:

```text
Task report.export
  SLO: 5 phút (do application khai báo)
  risk: cao — 80% các task cùng loại có thể vượt SLO nếu lag hiện tại giữ nguyên
  basis: 1.248 task đã quan sát, cửa sổ 14 ngày, handler version abc
```

Đây là risk indicator, không phải ETA và không được xuất hiện khi sample,
window hoặc SLO thiếu.

Acceptance criteria:

- Có sample size, time window, task type, handler version và lag basis trong UI.
- Không trộn các runtime/provider khác nhau vào một phân phối.
- Khi dữ liệu không đủ, hiển thị “Không có dữ liệu rủi ro”.
- Alert chỉ là recommendation; không tự pause hoặc retry nếu chưa có policy.

## 9. P2 — Preflight kinh tế cho Plan Inspector và bulk action

Trước khi chạy 5.000 item, người dùng phải thấy phạm vi ảnh hưởng, cost policy,
rate limit và điểm có thể bị block. Đây là lớp UX nối cost ledger với Safe Bulk
Actions đã có trong roadmap.

Preflight trả về:

- số item được chọn và số item thiếu evidence;
- nhóm Safe/Uncertain/Blocked;
- provider-call estimate theo policy (hoặc “unavailable”);
- rate/concurrency hard cap và handler đã đăng ký;
- yêu cầu approval, circuit-breaker condition và post-check;
- diff so với attempt trước nếu là recovery.

Không cho nhập SQL tùy ý và không dispatch khi preflight chưa được approve.

## 10. P2 — Adopter Fault Drill

Fault Lab hiện là năng lực nội bộ. Đóng gói một đường dẫn staging để adopter tự
kiểm tra integration của họ trước production:

```bash
rhinoq fault-drill --task <id> --scenario provider-timeout --environment staging
rhinoq fault-drill --task <id> --scenario lost-response --environment staging
```

Quy tắc:

- Chỉ chấp nhận environment đã đánh dấu disposable/staging và confirmation
  rõ ràng.
- Chỉ gọi fault handler đã đăng ký; không kill process hoặc sửa DB tùy ý.
- Kết quả phải cho thấy uncertain, reconciliation, post-check và rollback.
- Sinh report có thể gửi cho team, nhưng không gọi đây là production evidence.

## 11. Tích hợp nên ưu tiên và những tích hợp không nên làm

### 11.1. Nên làm qua port/adapter chung

| Tích hợp | Giá trị | Boundary |
| --- | --- | --- |
| OpenTelemetry/OTLP | correlation request → Task → provider span; nối Datadog/Grafana qua collector | adapter quan sát, không đưa collector vào Domain |
| CI/deploy metadata | regression theo handler version và link commit/deploy | application manifest/resource attributes |
| Billing/cost export | cost policy có nguồn, không hard-code vendor | `CostPolicyProvider` do app sở hữu |
| Email/push/webhook | owner notification và support receipt | outbound message ký HMAC |
| GitHub Action | `explain`/index guard fail PR trước khi deploy | read-only CLI, không mutate database |
| Provider readback | xác nhận effect, dispute receipt | provider adapter + confirmation policy |

### 11.2. Không nên làm

- Không viết native integration riêng cho Jira, PagerDuty, Slack, email và mọi
  hệ thống ticket. Một webhook/OTLP contract có version đủ để application nối.
- Không tự cài trigger/CDC vào bảng của adopter.
- Không gọi cloud billing hoặc Git provider trực tiếp từ Domain.
- Không dùng AI để đoán business outcome, owner, cost hay nguyên nhân causal.
- Không mở bulk retry chung chung; mọi action phải preview, approval, handler
  registry và post-verification.

## 12. Thứ tự triển khai đề xuất

| Ưu tiên | Gói việc | Phụ thuộc | Giá trị thấy ngay | Gate chuyển phase |
| --- | --- | --- | --- | --- |
| P0 | Trace projection + universal search + Task Center button | flight recorder, passport, owner auth | rất cao | fixture causal chain chạy được ở API/CLI/UI |
| P0 | Onboarding mở trace của task uncertain đã seed | `dev`, `up`, fixture | rất cao | clean-room smoke và screenshot không synthetic claim |
| P1 | Cost ledger + preflight cost impact | effect history, policy port | cao | không đoán khi thiếu policy; lost-response idempotent |
| P1 | Version regression | passport version/digest, verification | cao | baseline/sample gate, không claim causal quá mức |
| P1 | Evidence Receipt + owner retry gate | auth, redaction, reconciler | cao | two-owner isolation và unknown fail-closed |
| P2 | Risk window | measured history, declared SLO | trung/cao | thiếu dữ liệu hiển thị rõ, không ETA |
| P2 | Adopter Fault Drill | fault lab, disposable guard | cao khi demo | không chạy ngoài staging/disposable |

Không chuyển một gói sang “implemented” chỉ vì UI đã render. Mỗi gói phải có
contract version, test, evidence fixture, docs và rollback note.

## 13. Bộ issue có thể tách ngay

### RQ-LINK-001 — Trace resolver và causal projection

- **Scope:** resolver nhiều loại ID, join bounded, owner/tenant fence.
- **Output:** API schema v1, CLI JSON/readable, Workbench panel.
- **Test:** same projection from recorded facts; no cross-owner result.
- **Không làm:** full-text raw log search, invented timestamps.

### RQ-LINK-002 — Universal search UI và shareable trace URL

- **Scope:** search header, result type, keyboard navigation, opaque URL lens.
- **Test:** task/correlation/finding/provider ref; PII redaction.
- **Không làm:** lưu PII mới hoặc share operator token.

### RQ-MOAT-001 — Effect Cost Ledger

- **Scope:** cost policy port, immutable snapshot, preflight summary, digest.
- **Test:** missing policy, policy revision, duplicate/lost response, cap stop.
- **Không làm:** cloud billing auto-discovery.

### RQ-MOAT-002 — Regression theo handler version

- **Scope:** deployment identity, baseline query, sample gate, finding/notify.
- **Test:** same verifier/task type, small sample, version mismatch.
- **Không làm:** causal claim chỉ từ correlation.

### RQ-TRUST-001 — Evidence Receipt

- **Scope:** opaque token, TTL, allow-list, redaction, receipt endpoint.
- **Test:** owner/support scope, expired token, uncertain preservation.
- **Không làm:** legal/WORM claim trong phase đầu.

### RQ-OWNER-001 — Self-service retry và notification

- **Scope:** not-happened gate, owner command, notification adapter, audit.
- **Test:** uncertain không có retry; expected version conflict; duplicate command.
- **Không làm:** owner tự sửa business rule hoặc chạy handler chưa đăng ký.

### RQ-RISK-001 — Risk window theo SLO khai báo

- **Scope:** measured distribution, lag basis, no-ETA copy, risk finding.
- **Test:** insufficient sample/window/runtime separation.
- **Không làm:** dự báo khi thiếu evidence.

### RQ-ADOPT-001 — Staging Fault Drill

- **Scope:** disposable confirmation, registered scenarios, evidence report.
- **Test:** timeout/lost response/reconciliation/post-check.
- **Không làm:** destructive production chaos.

## 14. Definition of Done chung

Một tính năng trong backlog này chỉ được xem là hoàn thành khi:

1. Có contract/schema version và boundary rõ giữa Domain, Application, adapter
   và transport.
2. Có test deterministic cho success, missing evidence, unknown/uncertain,
   duplicate và authorization boundary.
3. Có fixture hiển thị giá trị trong Workbench/CLI; không chỉ có API.
4. Có preview-first cho mọi mutation, expected-version fence, idempotency và
   post-verification.
5. Không claim ETA, cost, reliability hoặc causal regression nếu chưa có raw
   evidence tương ứng.
6. README/guide cập nhật command, limitation và trạng thái release.
7. Có metric trước–sau: time-to-explanation, search resolution rate, action
   safety rejection, evidence completeness và adopter setup friction. Baseline
   phải được đo trước khi đặt target.

## 15. Quyết định đề xuất

Nếu chỉ chọn một vertical slice, làm theo thứ tự:

1. `rhinoq trace` + search hợp nhất trên fixture uncertain.
2. Nút “Vì sao uncertain?” mở thẳng causal timeline trong Task Center.
3. Cost ledger cho effect đã có policy và preflight recovery.
4. Version regression cho cùng task type/verifier.

Bốn bước này nối đúng dữ liệu RhinoQ đã sở hữu, tạo câu chuyện dễ hiểu với
người dùng và tránh biến sản phẩm thành một danh sách integration rời rạc.
