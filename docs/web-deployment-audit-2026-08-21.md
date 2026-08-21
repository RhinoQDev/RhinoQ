# RhinoQ web deployment audit

**Ngày audit:** 21/08/2026
**URL:** <https://web-rhinoq.onrender.com/>
**Phạm vi:** Home, 18 mục trong Docs, 4 lớp trong API Reference, Playground, chuyển ngôn ngữ EN/VI, tương tác enqueue và kiểm tra mobile ở 390×844.

## Kết luận điều hành

Website hiện có giao diện khá hoàn chỉnh nhưng đang mô tả sai sản phẩm so với repository hiện tại. Nội dung deploy xoay quanh một Redis queue API kiểu `Queue`/`Worker`, trong khi RhinoQ hiện là nền tảng async Task cho Node.js, NestJS và Go, với PostgreSQL queue native hoặc BullMQ adapter, Task API, progress, SSE, Evidence/Workbench và recovery có kiểm soát.

Vì vậy rủi ro lớn nhất không phải là thiếu một vài section UI mà là người dùng đọc website sẽ cài sai package, gọi sai API và hiểu sai mức độ sẵn sàng của sản phẩm. Cần sửa product contract trước khi tiếp tục đánh bóng giao diện.

## Những gì đã kiểm tra

| Khu vực | Trạng thái quan sát được |
|---|---|
| Home `/` | Hero, comparison RhinoQ/BullMQ/Raw Redis, architecture, code samples, metric claims, CTA |
| Docs `/docs` | 18 mục: Introduction, Quickstart, Installation, Configuration, Jobs, Queues, Workers, Events, Delayed/Cron, Retries, Rate limiting, Metrics, API và examples |
| API Reference `/api-reference` | Queue, Worker, QueueEvents, FlowProducer; mặc định mở QueueEvents dù sidebar đặt Queue đầu tiên |
| Playground `/playground` | Form queue/job/JSON payload, console mô phỏng enqueue/worker, latency hiển thị |
| EN/VI | Một phần navigation/sidebar đổi ngôn ngữ; vẫn còn nhãn tiếng Anh ở các khu vực chính |
| Mobile 390×844 | Home và Playground co được; Docs dồn sidebar dài lên trước nội dung, làm giảm khả năng tìm thấy nội dung chính |

## Findings theo mức độ ưu tiên

### P0 — phải sửa trước khi quảng bá hoặc đưa người dùng vào docs

#### 1. Product identity và API contract đang lệch nhau

Website tự nhận là “Next-Gen Redis Job Queue”, mô tả `Queue`, `Worker`, `QueueEvents`, `FlowProducer` được import từ `rhinoq`, và hướng dẫn `npm i rhinoq ioredis`.

Trong repository:

- `README.md` mô tả RhinoQ là async Task/background-job platform cho Node.js, NestJS và Go.
- Queue native là PostgreSQL; BullMQ là runtime/adapter hiện có.
- Node package canonical là `@rhinoq/node` phiên bản `0.1.0-beta.21`.
- `sdks/node/src/index.ts` export Task/Gateway/PostgreSQL/BullMQ/Workbench API; không export bộ lớp Redis `Queue`, `Worker`, `QueueEvents`, `FlowProducer` như docs deploy đang trình bày.

Đây là lỗi contract, không chỉ là lỗi copy. Người dùng làm theo code sample hiện tại có thể không chạy được với repository thật.

**Cách sửa:** chọn một thông điệp sản phẩm duy nhất và viết lại toàn bộ hero, docs, API reference, code sample theo public API thực tế. Nếu vẫn muốn giữ BullMQ, phải ghi rõ đó là integration với BullMQ hiện hữu, không phải Redis queue engine của RhinoQ.

#### 2. Version và mức độ sẵn sàng bị quảng bá sai

Docs deploy ghi `RhinoQ Docs • v1.0`; package hiện tại là `0.1.0-beta.21`; README cảnh báo rõ đây là prerelease cho evaluation/controlled pilots và chưa có production-ready claim.

**Cách sửa:** hiển thị version từ một nguồn duy nhất (package/release metadata), ví dụ `0.1.0-beta.21`, kèm badge “Public beta / controlled pilots”. Không dùng `v1.0` khi chưa có release tương ứng.

#### 3. Các số liệu hiệu năng/độ tin cậy không có ngữ cảnh bằng chứng

Home hiển thị các claim cố định:

- `100k+ Jobs/sec`
- `< 1ms Latency`
- `99.99% Reliability`
- “zero polling CPU overhead”

Repository yêu cầu không đưa claim throughput, latency hoặc reliability nếu không có matching benchmark/fault evidence; `docs/benchmarks.md` cũng nói các số đo hiện tại là local/environment-specific và không phải production capacity claim.

**Cách sửa:** bỏ các số cố định khỏi hero. Nếu cần giữ benchmark, hiển thị môi trường, commit, ngày đo, workload, p50/p95 và link evidence; tách rõ “local benchmark” khỏi SLA.

#### 4. Playground nhận JSON không hợp lệ nhưng vẫn báo thành công

Đã nhập `{invalid` vào ô JSON Payload và bấm **Simulate Enqueue**. Playground vẫn tạo job mới, log worker picked up và `Status: COMPLETED`, không có validation error.

Đây là lỗi nguy hiểm vì UI hứa hẹn mô phỏng payload JSON nhưng lại chấp nhận dữ liệu chắc chắn không parse được.

**Cách sửa bắt buộc:** `JSON.parse` trước khi enqueue; hiển thị lỗi ngay tại field, disable submit khi payload invalid, không ghi console success; thêm test cho empty/malformed/large payload.

### P1 — sửa trong đợt cập nhật nội dung và IA kế tiếp

#### 5. Website thiếu các capability đang là điểm khác biệt của RhinoQ

Trong README hiện có các capability đã triển khai nhưng không xuất hiện trên deploy: durable Task state, progress tracking, realtime SSE/polling fallback, owner-scoped Task API, Task Center, Workbench, Evidence Passport, Incident Flight Recorder, Rules/Findings, guarded recovery, Safe Bulk Actions và verification records.

Ngược lại, website dành phần lớn không gian cho Redis/Lua/DAG/rate-limit theo một sản phẩm khác. Đây là lý do người mới không hiểu RhinoQ giải quyết vấn đề nghiệp vụ nào.

**Cách sửa:** thêm các trang/product sections riêng cho:

1. Task lifecycle và progress (chỉ hiển thị progress khi có record, không đoán ETA).
2. Workbench/Incident Flight Recorder: queue wait, attempts, effects, outcomes, findings, recovery và compare-attempt.
3. Rules/Findings: test preview, explain, version, evidence.
4. Safe Bulk Actions: preview ảnh hưởng, Safe/Uncertain/Blocked, approval, registered handler, post-check.
5. Runtime choices: PostgreSQL native, BullMQ adapter, SQS/other adapters nếu được support.

#### 6. Link GitHub và thông tin hosting không đúng

Các link “GitHub Repository” trên Home/Footer trỏ tới `https://github.com` (trang chủ), không trỏ tới repository RhinoQ. Repository local có remote `https://github.com/RhinoQDev/RhinoQ.git`.

Footer còn ghi “Deployed effortlessly on Cloudflare Pages Edge Network”, trong khi URL người dùng đang truy cập là `web-rhinoq.onrender.com`.

**Cách sửa:** dùng URL repository thật; cập nhật hoặc bỏ claim hosting để khớp deployment thực tế.

#### 7. Code sample và API reference không có khả năng kiểm chứng từ repo

API Reference của deploy mô tả constructor/method Redis riêng (`queue.add`, `queue.pause`, `worker.close`, `FlowProducer`) nhưng không liên kết tới source/type declaration hoặc version cụ thể. Các sample này cần được sinh từ public `.d.ts`/OpenAPI hoặc được typecheck trong CI.

**Cách sửa:** mỗi API page phải có package/path/version, link source, ví dụ chạy được và trạng thái “stable / beta / development preview”. Tạo CI job để build/typecheck tất cả code block quan trọng.

#### 8. Docs/API subsection không có deep link

Đã click `Jobs & Lifecycle` trong `/docs` và `Queue` trong `/api-reference`; URL vẫn chỉ là `/docs` và `/api-reference`. Người dùng không thể bookmark, share hoặc mở thẳng một mục cụ thể; refresh cũng không thể khôi phục selection.

**Cách sửa:** dùng URL dạng `/docs/jobs-lifecycle` và `/api-reference/node/task-client`, hoặc ít nhất hash/query ổn định (`/docs#jobs-lifecycle`).

#### 9. Bản dịch VI chưa nhất quán

Sidebar/docs content có chuyển sang tiếng Việt, nhưng các nhãn chính như `API Reference`, `Playground` và nhiều code/section label vẫn tiếng Anh. Người dùng đang ở VI phải chuyển ngôn ngữ giữa chừng.

**Cách sửa:** quản lý toàn bộ label qua locale dictionary; thêm test snapshot cho EN/VI, không dịch identifier/code nhưng dịch heading, helper text, error, CTA và empty state.

#### 10. Playground đang trộn “mô phỏng” với tín hiệu giống dữ liệu thật

Playground có ghi “simulated”, nhưng đồng thời hiển thị `[REDIS] Connected to simulated Redis node (127.0.0.1:6379)`, `Latency: 1.2ms` và thời gian xử lý 1.4ms. Người mới rất dễ hiểu đây là telemetry thật hoặc benchmark của sản phẩm.

**Cách sửa:** đặt banner rõ “Browser-only simulation — no Redis connection”; bỏ latency cố định hoặc ghi “illustrative”; thêm progress/retry/uncertain/effect/outcome để demo đúng điểm khác biệt của RhinoQ.

### P2 — cải thiện UX sau khi contract đã đúng

#### 11. Mobile Docs ưu tiên navigation quá mạnh

Ở viewport 390×844, Home và Playground co vừa màn hình. Docs lại đưa gần toàn bộ sidebar dài lên phần nhìn đầu tiên; nội dung Introduction nằm phía dưới. Không thấy bằng chứng tràn ngang trong snapshot, nhưng người dùng mobile phải cuộn qua navigation dài trước khi đọc tài liệu.

**Cách sửa:** sidebar thành drawer/collapsible “Mục lục”, giữ heading và nội dung đầu tiên trong viewport; bổ sung sticky section selector và focus management.

#### 12. Information architecture chưa phản ánh nhiệm vụ của người dùng

Các mục hiện tại là một danh sách Redis primitives. Nên tổ chức theo intent:

- Bắt đầu: chọn runtime, cài đặt, tạo Task đầu tiên.
- Vận hành: progress, retry, cancellation, queue health, realtime.
- Điều tra: Flight Recorder, Evidence, Findings, Rules.
- Sửa an toàn: recheck, bulk preview, approval, recovery.
- Tích hợp: Node/NestJS, Go, BullMQ, provider adapters.
- Tham chiếu: API/version/changelog/limitations.

## Lộ trình cải thiện đề xuất

### Pha 0 — chặn sai lệch contract

1. Chốt product positioning theo README/release hiện tại.
2. Tạo một `product-manifest` chứa version, runtime, package, capability, maturity và evidence link.
3. Sửa package/install command, GitHub URL, hosting copy và version badge.
4. Xóa mọi performance/SLA claim không có evidence.
5. Sửa validation JSON của Playground và thêm regression tests.

### Pha 1 — viết lại nội dung theo workflow

1. Làm lại Home: “Durable Tasks + verified outcomes”, sau đó mới nói queue/runtime.
2. Thêm Quickstart thật cho Node/NestJS/Go và hai lựa chọn PostgreSQL/BullMQ.
3. Xuất bản các trang Task API, Progress/SSE, Workbench, Flight Recorder, Rules/Findings và Safe Recovery.
4. Sinh API reference từ type/OpenAPI thay vì nhập tay.
5. Thêm deep-link và changelog theo version.

### Pha 2 — biến Playground thành demo có giá trị

1. Validate payload và hiển thị lỗi inline.
2. Cho chọn scenario: success, retry, uncertain, blocked, recovery.
3. Hiển thị progress record thật của simulation (không đoán ETA).
4. Nối timeline kỹ thuật với outcome/evidence nghiệp vụ.
5. Gắn “simulation only” rõ ràng; không dùng số latency giả như benchmark.

### Pha 3 — hoàn thiện UX và trust

1. Hoàn tất i18n EN/VI.
2. Responsive drawer cho Docs/API, keyboard navigation và focus states.
3. Thêm accessibility audit (contrast, heading order, labels, live region cho console).
4. Theo dõi analytics cho docs search, CTA, install copy và lỗi Playground.

## Definition of done cho website

- Mọi install command trên website chạy đúng với package/version hiện tại.
- Mọi API sample được typecheck trong CI hoặc được đánh dấu rõ là pseudocode.
- Không còn claim throughput/latency/reliability không có evidence link, môi trường và ngày đo.
- Nhập JSON sai trong Playground không thể tạo một job thành công.
- Home, Docs, API và Playground cùng dùng một product manifest/version.
- Mục Docs/API có URL ổn định, mở trực tiếp được và khôi phục sau refresh.
- GitHub, hosting, release status và package metadata trỏ đúng nơi.
- Trên viewport mobile, nội dung chính không bị navigation dài che khuất.

## Ghi chú thay đổi

Audit này chỉ đọc website deploy và repository để lập report; chưa sửa product code hoặc deployment. Các finding P0 cần được xử lý trước khi tiếp tục thay đổi màu sắc/typography, vì UI đẹp nhưng contract sai sẽ làm tăng rủi ro cho người dùng mới.
