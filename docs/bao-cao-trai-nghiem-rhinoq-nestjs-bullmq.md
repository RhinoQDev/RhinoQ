# Báo cáo trải nghiệm RhinoQ trên dự án NestJS/BullMQ thực tế

Ngày thực hiện: 08/08/2026
Dự án thử nghiệm: <https://github.com/kingRayhan/poc.nestjs-bullmq-queue>
Commit gốc dùng để đo: `5995e9adcacada5d7dd1b54c527ec85698e8ec35`

## Trạng thái khắc phục sau báo cáo

Các mục sau đã được sửa và có test tái hiện:

- CLI liệt kê đủ queue phát hiện trong source.
- Apply từ chối khi có nhiều queue nhưng người dùng chưa chọn rõ.
- Có thể truyền `--queue` nhiều lần; generated module dùng chung một PostgreSQL
  pool và sở hữu/đóng một `QueueEvents` cho mỗi queue.
- NestJS nhận `src/rhinoq.module.ts` và `AppModule` được patch, không còn file
  `.mjs` đứng ngoài composition root.
- Package root export Nest API để build được với module resolution cũ của dự án
  pilot.
- Khi thiếu cấu hình database, CLI nói rõ PostgreSQL là service mới và hỗ trợ
  `--local-postgres` để sinh Compose local không ghi đè.
- Node adapter giữ principal trên request gốc; `--owner-property user.id` mount
  owner Task API và Task Center self-contained. Không có option này thì routes
  không được mount, tránh tin header owner do client tự gửi.

Durable retry/outbox đã qua fault test PostgreSQL + Redis + BullMQ thật, gồm cả
tình huống `Queue.add()` thành công nhưng HTTP acknowledgement bị mất. Rà soát
P0/P1 tiếp theo cũng đã bổ sung manifest `taskType/mode` riêng cho từng queue,
vị trí producer `queue.add()` theo file:dòng, QueueEvents readiness và lệnh
`adopt --verify-url` kiểm tra health + Task Center trên ứng dụng đang chạy.

## 1. Mục tiêu

Thử đóng vai một lập trình viên chưa từng dùng RhinoQ, lấy một dự án BullMQ có
sẵn trên GitHub rồi tích hợp RhinoQ theo đúng tài liệu và CLI hiện tại.

Pilot cần trả lời bốn câu hỏi:

1. Người dùng có thể tích hợp RhinoQ nhanh và đúng ngay lần đầu không?
2. RhinoQ có thực sự xóa được code quản lý trạng thái Task không?
3. NestJS, BullMQ và PostgreSQL đã được ghép thành một vertical slice chưa?
4. Phần nào của RhinoQ vẫn khiến người dùng phải tự thiết kế hoặc tự nối dây?

## 2. Vì sao chọn dự án này

Đây là repository bên ngoài, không phải fixture do RhinoQ tạo ra. Dự án đủ nhỏ
để nhìn rõ chi phí tích hợp nhưng vẫn có cấu trúc thực tế:

- 26 file được Git quản lý;
- 355 dòng TypeScript production;
- ba module queue;
- có producer và worker BullMQ;
- có CLI 186 dòng để xem và quản lý trạng thái queue;
- dùng NestJS 10, `@nestjs/bullmq` và BullMQ 5.

Dự án không có PostgreSQL, xác thực người dùng hay frontend. Vì vậy pilot này
đo chính xác trải nghiệm backend NestJS/BullMQ, nhưng không được dùng để khẳng
định RhinoQ đã giảm bao nhiêu dòng React.

## 3. Quy trình đã thực hiện

Các lệnh được chạy như một người dùng package bình thường:

```text
npm install
npm run build
npm install <gói @rhinoq/node beta.9 đã đóng gói> pg
npx rhinoq adopt --mode single
npx rhinoq adopt --mode single --apply
npm run build
npx rhinoq doctor
```

Không import trực tiếp source RhinoQ và không sửa kết quả để làm đẹp phép đo.

## 4. Kết quả đo được

### 4.1 Baseline

- Dự án gốc build thành công.
- Dự án có ba queue nhưng chưa có khái niệm Task hướng tới người dùng.
- Có 186 dòng CLI quản trị queue, nhưng đây là công cụ operator, không phải Task
  Center dành cho owner.

### 4.2 Sau khi cài RhinoQ

- Thêm hai dependency trực tiếp: `@rhinoq/node` và `pg`.
- Cây dependency đã cài tăng thêm 14 package.
- CLI nhận diện đúng `pg`, BullMQ và NestJS.
- Chế độ preview không ghi file, đúng kỳ vọng.
- Chế độ apply sinh một file `rhinoq.integration.mjs` gồm 14 dòng.
- NestJS vẫn build thành công.
- Tuy nhiên file sinh ra không được import vào `AppModule`, nên RhinoQ chưa hề
  chạy dù CLI đã báo `PASS` và build vẫn xanh.
- `rhinoq doctor` từ chối chạy vì dự án không có kết nối PostgreSQL. Đây là kết
  quả fail đúng về correctness.

### 4.3 Số dòng code thực sự được xóa

Không có dòng source cũ nào được xóa.

Kết quả giảm code của pilot này: **0 dòng**.

Không được tính việc xóa CLI 186 dòng vì CLI đó quản trị Redis/BullMQ, trong khi
Task Center phục vụ owner và Task lifecycle. Hai thứ không hoàn toàn thay thế
nhau; xóa CLI chỉ để tạo số liệu đẹp sẽ là phép đo sai.

## 5. Những điểm chưa tốt của RhinoQ

### P0.1 — CLI báo PASS khi NestJS chưa tích hợp RhinoQ

Đây là vấn đề nghiêm trọng nhất.

File `.mjs` được sinh ở thư mục gốc, nằm ngoài luồng composition TypeScript
thông thường của NestJS. Không có module nào import hoặc gọi nó. Người dùng có
thể thấy:

- `adopt --apply` báo thành công;
- `npm run build` thành công;
- nhưng RhinoQ không được khởi động.

Đây là false-completion: công cụ báo hoàn thành trước khi outcome thực tế được
xác nhận — đúng loại vấn đề RhinoQ muốn giúp người khác tránh.

Cần nâng cấp:

- Khi phát hiện NestJS, sinh một module TypeScript đúng chuẩn Nest.
- Tự patch hoặc đưa ra patch chính xác cho `AppModule`.
- Chỉ báo PASS sau khi xác minh module được import.
- `doctor` cần phân biệt database reachable với application đã mount/start
  RhinoQ thật sự.

### P0.2 — Ứng dụng nhiều queue bị thu thành một queue mà không cảnh báo

Dự án có `mail-queue`, `notification-queue` và queue invoice. CLI chỉ yêu cầu
một lựa chọn `single` hoặc `fanout`, rồi sinh function nhận một biến `queue`.

Người dùng không biết:

- queue nào đang được tích hợp;
- queue nào bị bỏ sót;
- mỗi queue tương ứng Task type nào;
- mỗi queue dùng single hay fanout;
- owner của từng Task lấy từ đâu.

Cần nâng cấp:

- Liệt kê toàn bộ queue tìm được trong preview.
- Bắt buộc chọn queue cần tích hợp.
- Cho khai báo riêng cardinality theo từng queue.
- Sinh manifest dạng:

```ts
[
  { queue: 'mail-queue', taskType: 'mail.send', mode: 'single' },
  { queue: 'notification-queue', taskType: 'notification.send', mode: 'single' },
]
```

- Cảnh báo rõ queue nào chưa được RhinoQ theo dõi.

### P0.3 — `QueueEvents` chưa phải trải nghiệm turnkey cho NestJS

Code sinh ra yêu cầu người dùng truyền `queueEvents`. Trong ứng dụng
`@nestjs/bullmq` thông thường, người dùng inject `Queue` và dùng decorator cho
worker/event listener; họ không nhất thiết có sẵn một instance `QueueEvents`
injectable.

Nếu tự tạo `new QueueEvents()`, người dùng phải xử lý thêm:

- kết nối Redis riêng;
- cấu hình connection;
- lifecycle khởi động;
- đóng connection khi shutdown;
- tránh tạo trùng ở nhiều replica.

Đây chính là loại wiring RhinoQ nên xóa hộ.

Cần nâng cấp:

- Nest adapter tự tạo và đóng `QueueEvents` từ cấu hình queue đã đăng ký; hoặc
- cung cấp provider/token chính thức và sinh code provider hoàn chỉnh;
- health phải phản ánh connection event đã hoạt động hay chưa.

### P0.4 — `RhinoQModule` chưa mount vertical slice hoàn chỉnh

`RhinoQModule.forBullMQAsync()` hiện export các token task, bridge và health,
nhưng chưa tự mount:

- Task list;
- Task detail;
- execution history;
- cancel;
- retry;
- result resolution;
- health route;
- Task Center.

Người dùng vẫn phải tự tìm token, viết controller/middleware, nối auth, tạo
browser entry và quyết định URL UI.

Cần nâng cấp API theo hướng:

```ts
RhinoQModule.forBullMQAsync({
  applicationRoutes: {
    path: '/tasks',
    ownerFromRequest,
    retryTask,
    resolveResult,
  },
  taskCenter: {
    path: '/task-center',
  },
});
```

Sau khi cấu hình, người dùng phải có ngay một vertical slice chạy được.

### P1.1 — PostgreSQL là bước nhảy hạ tầng lớn với ứng dụng Redis-only

RhinoQ cần PostgreSQL làm durable authority là quyết định đúng. Tuy nhiên CLI
hiển thị “existing PostgreSQL” trong khi repository không hề có PostgreSQL.

Với người dùng nhỏ, họ phải thêm:

- một service PostgreSQL;
- connection string;
- secret/configuration;
- migration lifecycle;
- backup và vận hành database.

Thông báo hiện tại làm chi phí này trông nhỏ hơn thực tế.

Cần nâng cấp:

- Nhận diện dự án chưa có PostgreSQL.
- Ghi rõ “cần thêm một service mới”.
- Sinh đoạn Docker Compose chính xác cho local evaluation.
- Tách hướng dẫn local demo khỏi production deployment.
- Ước lượng rõ các bước vận hành mới, không chỉ dependency npm.

### P1.2 — Task identity và owner identity vẫn là việc thiết kế thủ công

`defineTask()` giảm phần wiring ID sau khi người dùng đã quyết định:

- stable Task ID;
- owner ID;
- Task type;
- single hay fanout;
- item key;
- result reference.

CLI chưa tìm các producer và chưa đặt checklist cạnh nơi `queue.add()` đang
được gọi. Người mới dễ chọn `Date.now()` hoặc BullMQ job ID làm business
identity không ổn định.

Cần nâng cấp:

- Phát hiện các vị trí `queue.add()`.
- Sinh typed TODO cạnh từng producer.
- Giải thích bằng business example ngay tại code sinh ra.
- Cho build fail cho đến khi identity và owner semantics được khai báo rõ.

### P1.3 — Chưa có retry durable hoàn chỉnh để copy cho NestJS

RhinoQ yêu cầu `commandId` và không nhận retry callback thường là crash-safe.
Điều này đúng. Nhưng adopter vẫn phải tự thiết kế:

- command table;
- transaction;
- version fence;
- Task transition;
- outbox record;
- publisher/recovery worker;
- xử lý enqueue đã thành công nhưng response bị mất.

Cần nâng cấp:

- Cung cấp optional PostgreSQL outbox adapter; hoặc
- một reference implementation NestJS hoàn chỉnh;
- có fault test cho crash trước/sau commit và trước/sau enqueue;
- correctness vẫn phải nằm ở Go/PostgreSQL, không chuyển vào React hoặc callback
  TypeScript in-memory.

### P2.1 — Task Center khó được phát hiện

Package đã có `mountRhinoTaskCenter()`, nhưng:

- CLI không nhắc tới;
- file sinh ra không mount;
- Nest module không expose page;
- không có URL được in sau khi khởi động.

Một backend adopter rất dễ kết luận RhinoQ vẫn chưa có UI cho end user.

Cần nâng cấp:

- Cho Task Center xuất hiện trong adoption preview.
- Sinh route mount sẵn.
- Sau startup, in URL chính xác.
- `doctor` kiểm tra URL này trả về thành công.

### P2.2 — Package tạo cảm giác hơi rộng

Gói npm đã đóng chứa 211 file, kích thước unpacked khoảng 1,3 MB. Đây chưa phải
lỗi runtime, nhưng tạo cảm giác lớn với người chỉ muốn Nest/BullMQ Task slice.

Cần cân nhắc:

- export rõ phần server, browser và Nest;
- tài liệu hóa capability nào được kéo vào;
- bảo đảm browser bundler không phải phân tích module chỉ chạy trên Node;
- có installed-package smoke test cho từng subpath.

Lưu ý: repository thử nghiệm có 44 cảnh báo `npm audit` từ dependency cũ. Các
cảnh báo này đã tồn tại trong cây dependency của dự án và không được quy trách
nhiệm cho RhinoQ.

## 6. Những điểm RhinoQ đã làm tốt

- Preview-first an toàn và không ghi đè file.
- Nhận diện đúng NestJS, BullMQ và PostgreSQL driver.
- File sinh ra ngắn, dễ đọc và hợp lệ về cú pháp.
- `doctor` fail rõ ràng khi không có durable datastore.
- Không tự đoán owner ID.
- Không tự đoán single/fanout trong chế độ apply.
- Không quảng cáo callback `queue.add()` thông thường là crash-safe.
- Cancellation active giữ nguyên nguyên tắc fail-closed.
- Các primitive Task, result, retry identity và UI state đã tiến gần đúng hướng.

## 7. Kết luận trung thực

RhinoQ hiện đã có nhiều primitive tốt, nhưng với một ứng dụng NestJS/BullMQ
bình thường, người dùng vẫn phải tự xây phần composition quan trọng:

- PostgreSQL service;
- Nest composition root;
- `QueueEvents` provider;
- mapping nhiều queue;
- owner/auth callback;
- application routes;
- Task Center mount;
- durable retry/outbox.

Vì vậy chưa thể nói RhinoQ đã giúp dự án pilot giảm code. Kết quả đo hiện tại là
0 dòng bị xóa và 14 dòng skeleton được sinh, nhưng skeleton chưa được mount.

Đây không phải thất bại của Task model; đây là khoảng trống product integration.
RhinoQ nên ưu tiên xóa nguyên vertical slice thay vì tiếp tục thêm các primitive
rời rạc.

## 8. Thứ tự nâng cấp đề xuất

### Giai đoạn 1 — phải hoàn thành trước

1. CLI phát hiện và bắt chọn từng queue.
2. Sinh Nest module TypeScript và patch `AppModule`.
3. Nest adapter tự quản lý `QueueEvents`.
4. Mount trọn bộ owner routes và Task Center.
5. Chỉ báo PASS khi app thực sự import, start và health check thành công.

### Giai đoạn 2 — giảm code backend thật sự

1. Multi-queue Task manifest.
2. Typed identity/owner checklist cạnh từng producer.
3. Durable retry/outbox reference implementation.
4. Docker Compose/local evaluation PostgreSQL generator.
5. Health check bao gồm database, projector, QueueEvents, routes và UI.

### Giai đoạn 3 — chứng minh giá trị

1. Chạy lại đúng repository này sau khi sửa P0.
2. Tích hợp một repository có React/Next.js để đo frontend.
3. Đếm riêng dòng thêm, dòng sửa và dòng xóa.
4. Đo số endpoint, hook, status mapping và lifecycle handler được loại bỏ.
5. Chỉ công bố claim giảm code sau khi adopter cũ thực sự xóa được plumbing.

## 9. Tiêu chí để lần pilot tiếp theo được coi là thành công

Pilot tiếp theo chỉ được đánh dấu thành công khi:

- `adopt --apply` tạo thay đổi build được và được import thật;
- tất cả queue trong scope được liệt kê rõ;
- một Task được dispatch và đọc lại qua owner route;
- progress/history/cancel/retry/result hoạt động end-to-end;
- Task Center mở được bằng URL được CLI cung cấp;
- restart process không làm mất Task hoặc retry command;
- không retry mù một outcome `uncertain`;
- source plumbing cũ được xóa thật và có số đo diff tái hiện được.

Cho đến khi đạt các điều kiện này, RhinoQ nên mô tả mình là đã có nền tảng Task
correctness và integration primitives, chưa nên claim “tích hợp vài dòng” hoặc
“xóa hàng trăm dòng frontend/backend”.

## Cập nhật kiểm chứng ngày 09/08/2026

Đã chạy lại trên chính repository pilot sau các thay đổi:

- CLI phát hiện đủ ba queue: `invoice-queue`, `mail-queue`,
  `notification-queue`;
- generated `src/rhinoq.module.ts` dùng chung PostgreSQL pool, quản lý ba
  `QueueEvents`, mount owner routes `/tasks` và Task Center `/task-center`;
- `AppModule` được patch và NestJS build thành công;
- Compose PostgreSQL local được sinh riêng, chỉ bind loopback và không ghi đè;
- repository pilot thiếu dependency `commander` dù source đã import nó. Build
  baseline chỉ đi tiếp sau khi bổ sung dependency này; đây là lỗi của pilot,
  không phải lỗi generated RhinoQ.

Go/PostgreSQL hiện có `TaskRetryStore` và migration 029 để commit command
identity, Task transition, Execution mới và outbox intent trong một transaction.
Integration test PostgreSQL thật đã xác nhận hai retry đồng thời chỉ tạo một
command, một Execution và một outbox event.

Dispatch intent mang đầy đủ `queue`, `jobName`, `data` và fingerprint. Go Agent
có HTTPS/HMAC outbox publisher; Node có BullMQ receiver giới hạn theo registry
queue và dùng `executionId` làm `jobId`. Fault test PostgreSQL + Redis + BullMQ
thật đã cắt socket sau khi `Queue.add()` thành công nhưng trước HTTP
acknowledgement, làm Agent đầu tiên dừng với outbox chưa settle. Sau khi khởi
động Agent thứ hai, event được giao lại, hội tụ về đúng một BullMQ job và outbox
được đánh dấu published. Retry job cũng bị ép `removeOnComplete: false` và
`removeOnFail: false`, nên job nhanh không biến mất trong cửa sổ acknowledgement.

Kết quả này chứng minh at-least-once + stable identity cho fault đã kiểm tra;
không biến thành claim exactly-once cho mọi lỗi mạng hoặc mọi cấu hình runtime.

## Rà soát lại P0/P1/P2

| Mục | Trạng thái | Bằng chứng hoặc phần còn lại |
|---|---|---|
| P0.1 | Đã xử lý | Sinh/import Nest module và `adopt --verify-url` kiểm tra app đang chạy. |
| P0.2 | Đã xử lý | `--task queue=task.type:mode`, manifest export và cảnh báo queue chưa theo dõi. |
| P0.3 | Đã xử lý | Sở hữu lifecycle QueueEvents; startup chờ `waitUntilReady`; health báo trạng thái connection. |
| P0.4 | Đã xử lý | Owner routes, history/cancel/retry/result/health và Task Center được mount cùng module. |
| P1.1 | Đã xử lý cho evaluation | Nhận diện PostgreSQL mới và sinh Compose loopback. Production operation vẫn thuộc adopter. |
| P1.2 | Còn một phần | Đã tìm producer theo file:dòng và bắt khai báo task type/mode. Stable business ID/owner tại từng producer vẫn cần quyết định nghiệp vụ, không thể tự đoán an toàn. |
| P1.3 | Đã xử lý | Transactional retry, command fingerprint, outbox publisher, BullMQ receiver và fault test thật. |
| P2.1 | Đã xử lý | CLI mount/in URL Task Center và runtime verifier kiểm tra trang thật. |
| P2.2 | Đã giảm đáng kể | Có subpath `browser`, `react`, `bullmq`, `server` và smoke test ESM/CommonJS. Vẫn cần đo bundle/tree-shaking trong adopter frontend thật. |

Khoảng trống bằng chứng lớn nhất hiện không còn là correctness primitive mà là
pilot frontend React/Next.js và phép đo code bị xóa trong adopter thật. Không
nên tự động sửa producer khi chưa biết business identity; CLI phải chỉ đúng vị
trí và buộc người dùng đưa ra quyết định đó một cách tường minh.

## Rà soát capability effectively-exactly-once và lý do chọn RhinoQ

### Phần đã được nối thành luồng sử dụng

- `ProviderOperation` dự trữ identity trước mutation, ràng buộc request
  fingerprint và không retry mù khi mất acknowledgement.
- Agent có API bounded, oldest-first để lấy `pending`, `accepted` và
  `uncertain` operation cần xác nhận.
- `ProviderOperationReconciler` chỉ nhận callback read-back theo
  `provider.operation`; nó không thể gọi lại mutation.
- `effectCapabilityReport()` chỉ trả
  `effectively-exactly-once` khi effect có stable identity, provider thực thi
  idempotency key, confirmation/verifier phù hợp và retry chỉ sau bằng chứng
  `not_happened`.
- Durable BullMQ retry, fail-closed cancellation và bounded reconciliation đã
  có code/test; roadmap và feature matrix cũ ghi “unfinished” đã được sửa.

### Lý do thực tế để adopter chọn RhinoQ

1. Giữ BullMQ/queue hiện có nhưng thêm truth layer PostgreSQL, không buộc viết
   lại handler thành một workflow runtime mới.
2. Không biến timeout thành “failed”: lưu `uncertain`, giữ evidence và hỗ trợ
   read-back recovery an toàn.
3. Xóa một vertical slice backend/frontend: Task routes, owner auth callback,
   hooks, Task Center, cancel, retry, history và authorized result.
4. Có fault evidence cho crash giữa PostgreSQL, HTTP acknowledgement và BullMQ,
   thay vì chỉ có happy-path unit test.
5. Capability report làm claim theo từng effect; adopter biết chính xác effect
   nào chỉ at-least-once và effect nào đạt effectively-exactly-once.

### Phần vẫn chưa nên quảng bá là hoàn thành

- RhinoQ không thể tự sinh business identity đúng; application vẫn phải chọn
  order/refund/report key ổn định.
- Webhook authentication và provider-specific read-back vẫn thuộc application;
  RhinoQ không thể xác minh Stripe, storage hoặc API riêng nếu không có adapter
  và credential của adopter.
- Tenant-wide HTTP authorization chưa đồng đều trên mọi subsystem.
- Reverse search bằng business key/external job, `init --from-scan`, signed/WORM
  audit checkpoint và public tagged release vẫn là adoption/release gap.
- Chưa có bằng chứng bundle/LOC mới từ một adopter React/Next sau lần nâng cấp
  này; không nên đưa con số tiết kiệm code trước khi đo lại.

Kết luận: lý do khác biệt nhất của RhinoQ không phải “có thêm queue UI”, mà là
khả năng phủ lên stack hiện hữu để chứng minh external effect và business
outcome đã thật sự đúng, đồng thời giảm code Task UX cho cả backend lẫn frontend.

## Xác minh lại SSE của RhinoQ

Rà toàn repository cho thấy trước thay đổi này SSE chỉ tồn tại trong ứng dụng
adopter cũ và tài liệu đo chi phí; RhinoQ có TaskStore polling/reconnect nhưng
không có route `text/event-stream`, parser hay live hook. Vì vậy ký ức “đã làm
SSE” là đúng đối với dự án mẫu, chưa đúng đối với public RhinoQ Task slice.

Phần đã bổ sung:

- `GET /tasks/{id}/events` cho một Task và `GET /tasks/_events` cho owner inbox;
- authorization bằng callback của application trước khi mở stream;
- versioned snapshot event, `Last-Event-ID` cho item và page-reset event cho
  inbox bounded;
- heartbeat, abort cleanup, no-buffer headers và connection budget;
- Fetch streaming client dùng được cookie hoặc application auth headers;
- TaskStore/TaskListStore, `createUseRhinoTaskLive()`,
  `createUseRhinoTasksLive()` và Task Center live-first;
- snapshot polling fallback rồi tự thử nối SSE lại;
- Node/Nest streaming response và Fastify raw-response path;
- test owner isolation, stale/replay convergence, page displacement, stream
  loss, capacity release và middleware không buffer.

Giới hạn trung thực: implementation mặc định vẫn đọc snapshot bounded ở server
để phát hiện version mới. Nó giảm request/re-render glue ở frontend và tạo live
UX, nhưng chưa phải shared Redis fan-out cho hàng chục nghìn connection. Cần đo
database/connection load trước khi đưa ra scalability claim.
