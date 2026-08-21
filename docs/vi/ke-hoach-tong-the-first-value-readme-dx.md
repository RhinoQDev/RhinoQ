# RhinoQ — kế hoạch tổng thể để người mới thấy giá trị ngay

> Cập nhật: 2026-08-21
> Phạm vi: định vị sản phẩm, README, website, first run, CLI, generator, API/DX,
> Task Center, Workbench và luồng áp dụng vào ứng dụng có sẵn.
> Trạng thái: audit + kế hoạch đang được triển khai theo goal First Value. Các
> mục ghi **đề xuất** vẫn chưa phải capability đã phát hành.

## Tiến độ triển khai goal First Value

Đã triển khai trong workspace này:

- **FTV-002** — `npx rhinoq dev --demo` mở Workbench disposable không cần
  PostgreSQL/Redis/provider, có progress thật theo fixture, result và failure;
- **FTV-003** — `npx rhinoq up` tạo profile PostgreSQL 16 cục bộ, chờ health,
  migrate, tạo fixture và mở Workbench; `--dry-run` chỉ in kế hoạch;
- **FTV-004/005/007/009** — đồng bộ beta.21/PostgreSQL 16, gỡ claim
  `create-rhinoq-app` chưa kiểm chứng khỏi đường bắt đầu, sửa S3 thành peer
  tùy chọn và fail-closed semantics cho setup/adopt;
- **FTV-006 (phần an toàn)** — report-export generator có Task handler,
  progress/result metadata và `.env` chạy bằng Node 22; adapter manual vẫn
  ghi rõ observe-only, chưa giả vờ dispatch production khi chưa có runtime;
- **DX-001/002/003/004/005/006** — thêm `connect`, `add task` (sinh handler,
  manifest/plan smoke test và handoff `/task-center`),
  `TaskRunHandle`, help theo nhóm,
  `doctor --fix` chỉ sửa local plumbing và Integration Eraser summary-first
  với `.rhinoqignore`/generated/vendor filtering;
- **FTV-010 (đã có guard offline)** — CI có smoke check cho first-value command,
  quickstart, docs link, stale claim và clean-room CLI từ thư mục tạm; smoke này
  không giả vờ thay cho clean-room Docker/npm đa nền tảng, vẫn là gate phát hành
  riêng.
- **UI-001..010 (nền hiện có)** — Workbench/Task Center đã có progress không
  đoán ETA, Flight Recorder, compare attempt, Rule Console, safe bulk preview,
  responsive/resizable layout, saved views và SSE/polling fallback.

Các mục còn cần evidence hoặc hạ tầng thật, như clean-room đa nền tảng,
framework starters, provider evidence và guarded autopilot, vẫn để ở backlog;
README không quảng bá chúng như đã hoàn thành.

## 1. Kết luận điều hành

Có, README cần được viết lại đáng kể. Vấn đề không chỉ là nhiều chữ mà là
**người mới phải học quá nhiều trước khi thấy RhinoQ làm được gì cho họ**.

Hiện tại RhinoQ có chiều sâu kỹ thuật và đã có nhiều mảnh sản phẩm đáng giá:
Task API, Task Center, Workbench, progress, lịch sử attempt, realtime, Rules,
Findings, recovery có kiểm soát và các lớp evidence. Tuy nhiên, đường vào sản
phẩm đang buộc người dùng đi qua kiến trúc, thuật ngữ và lựa chọn runtime trước
khi họ thấy một Task thật chạy và một giao diện thật cập nhật.

Nếu giữ trải nghiệm hiện tại, rủi ro lớn nhất không phải người dùng nghĩ RhinoQ
thiếu tính năng. Rủi ro là họ kết luận quá sớm rằng:

- phải cài nhiều thứ;
- phải hiểu Task, Execution, Rule, Finding, Effect và runtime adapter trước;
- phải thay queue/worker hiện có;
- phải có PostgreSQL trước khi nhìn thấy sản phẩm;
- BullMQ đơn giản hơn vì ví dụ đầu tiên của BullMQ quen thuộc hơn;
- RhinoQ là một hệ thống vận hành chuyên sâu, chưa phải thứ “cắm vào là có ích”.

Vì vậy, ưu tiên số một không phải thêm một capability chuyên sâu nữa. Ưu tiên
là rút ngắn thời gian từ lúc vào README đến lúc người dùng nhìn thấy:

1. một tác vụ đang chạy;
2. phần trăm tiến độ thật;
3. trạng thái, lịch sử và lỗi dễ hiểu;
4. nút hủy/thử lại đúng quyền;
5. kết quả hoặc file đầu ra;
6. đường dẫn có thể đưa thẳng vào ứng dụng của họ.

Lời hứa sản phẩm nên được thu gọn thành:

> Giữ worker hiện có. RhinoQ bổ sung Task API, tiến độ, kết quả, hủy, lịch sử
> attempt và giao diện cho người dùng lẫn đội vận hành.

Đây là wedge dễ thấy ngay. “Outcome verification”, “Incident Flight Recorder”
và “Safe Recovery” là lý do để ở lại và mở rộng sau đó, không nên là thuế kiến
thức trước lần chạy đầu tiên.

## 2. Tài liệu này là nguồn tổng hợp cho việc gì

Tài liệu này gom các vấn đề đã xuất hiện rải rác trong audit website, so sánh
DX, kế hoạch nâng cấp, backlog tích hợp và các lần kiểm tra giao diện thành một
backlog sản phẩm duy nhất cho chủ đề **first value và adoption**.

Nó trả lời bốn câu hỏi:

1. Vì sao người mới có thể từ chối RhinoQ trước khi thử xong?
2. Cần sửa README và kiến trúc tài liệu như thế nào?
3. Cần đổi product/CLI/API/UI gì để lời hứa “cắm là chạy” là thật?
4. Dựa vào tiêu chí nào để biết việc sửa đã hoàn thành?

Tài liệu này không thay thế specification của engine, lease, retry, effect
ledger hoặc security. Các correctness contract đó vẫn phải theo kiến trúc hiện
có và không được chuyển vào SDK chỉ để làm API trông ngắn hơn.

## 3. Bằng chứng hiện trạng

### 3.1 README đang là một handbook thay vì một trang bắt đầu

Tại thời điểm audit, README có xấp xỉ:

| Chỉ số | Hiện trạng |
|---|---:|
| Dòng | 1.724 |
| Từ | 11.171 |
| Tiêu đề cấp 2 | 27 |
| Khối code | khoảng 49 |
| Vị trí lệnh cài đầu tiên | khoảng dòng 157 |

Trước lệnh cài đầu tiên, người đọc đã gặp Workbench, Incident Flight Recorder,
Safe Bulk Actions, Rule preview, multi-tenancy boundary, outcome verification,
effect identity, reconciliation, data path, WebSocket Hub, checkpoints,
Autopilot, module lifecycle và capability ledger.

Số lần một vài thuật ngữ xuất hiện trong README cũng phản ánh cognitive load:

| Thuật ngữ | Số lần gần đúng |
|---|---:|
| Task | 235 |
| adapter | 55 |
| provider | 52 |
| Rule | 42 |
| Workbench | 38 |
| tenant | 37 |
| Execution | 28 |
| SSE | 28 |
| Finding | 20 |
| effect | 21 |
| fence | 15 |

Số lượng không tự động có nghĩa nội dung kém, nhưng thứ tự hiện tại khiến người
mới phải giải mã mô hình hệ thống trước khi thấy kết quả. README còn có nhiều
đường “bắt đầu” trùng nhau: Quick start, New here, Start here, Adding it to an
application, demo và các guide riêng.

### 3.2 First run chưa tạo ra khoảnh khắc “à, ra là thế”

`npx rhinoq eval` kiểm tra được PostgreSQL, schema, fixture, owner API, HTML của
Task Center và Workbench. Nhưng server loopback được đóng ngay sau kiểm tra.
Người dùng nhận một danh sách `PASS`, không được tự nhìn Task chạy trong trình
duyệt.

`npx rhinoq dev` mở Workbench bền hơn nhưng:

- vẫn yêu cầu PostgreSQL đã được cấu hình;
- không tự tạo một Task đang chạy nếu database trống;
- không tự mở trình duyệt;
- người dùng phải biết chạy fixture riêng;
- URL Node Workbench và Go Workbench hiện không cùng một port/đường dẫn.

Quickstart “khoảng năm phút” thực tế yêu cầu người dùng:

1. chạy Docker PostgreSQL;
2. chờ `pg_isready`;
3. tạo thư mục;
4. `npm init`;
5. cài package;
6. đặt biến môi trường đúng shell;
7. chạy `eval`;
8. chạy thêm `dev` nếu muốn xem giao diện.

Đó là một bài kiểm tra hạ tầng tốt, nhưng chưa phải demo giá trị sản phẩm tốt.

### 3.3 Setup phát hiện môi trường nhưng chưa đủ an toàn để “ấn Enter”

Kết quả kiểm tra thực tế cho thấy:

- repository Node không có BullMQ/Go được auto-select thành `manual`;
- manual adapter chỉ là boundary thủ công, không tự thực thi công việc;
- repository fan-out BullMQ vẫn được gợi ý mode `single` nếu người dùng không
  khai báo;
- khi semantics chưa rõ, `adopt` vẫn in next action với `--mode single`;
- `setup --local-postgres` chỉ sinh Compose rồi yêu cầu người dùng tự chạy,
  tự đợi, tự đặt URL và tiếp tục;
- file Compose được sinh dùng PostgreSQL 17 trong khi README, quickstart và ma
  trận test công khai nói PostgreSQL 16.

Nguyên tắc cần giữ: khi không biết một hành động người dùng tương ứng một job hay
nhiều job, RhinoQ phải dừng ở `needs decision`; không chọn `single` để tạo cảm
giác setup đã xong.

### 3.4 Generator hiện chưa tạo một ứng dụng mẫu chạy thật

`npx rhinoq init --example report-export` hiện có các vấn đề:

- sinh dependency `@rhinoq/node` beta.20 trong khi repository và release được
  xác minh đang là beta.21;
- script `start` chỉ chạy `node app.mjs` nhưng README của mẫu yêu cầu copy
  `.env`; Node không tự nạp `.env` theo cách đó và template không import dotenv;
- app tạo product surface quanh manual adapter nhưng không khai báo handler,
  dispatch route hoặc một report export thật;
- owner identity yêu cầu header `x-demo-session`; người mở Task Center bình
  thường trong browser không có cách thuận tiện để tự thêm header này;
- token mẫu là `replace-me`;
- kết quả và verifier cố ý fail-closed, nhưng người mới dễ hiểu nhầm sample bị
  hỏng.

Tên “report-export” tạo kỳ vọng có report được xử lý. Template hiện tại mới là
shell tích hợp, chưa đáp ứng kỳ vọng đó.

README còn quảng bá `npx create-rhinoq-app@next my-batch`, nhưng audit repository
không tìm thấy source/package tương ứng. Trước khi giữ claim này, release
pipeline phải chứng minh package tồn tại, cài được từ máy sạch và tạo app chạy
được. Nếu không, phải bỏ lệnh khỏi README.

### 3.5 Tài liệu và package chưa có một nguồn version duy nhất

Các sai lệch đã thấy:

- package chính là beta.21 nhưng một số README và generator vẫn dùng beta.20;
- tài liệu tiếng Việt vẫn cài beta.20;
- generated local Compose dùng PostgreSQL 17, trong khi public tested contract
  ghi PostgreSQL 16;
- SDK README nói AWS S3 SDK đã đi kèm, nhưng `sdks/node/package.json` để các AWS
  package ở optional peer dependencies và `dependencies` đang rỗng;
- website deploy từng hiển thị version/claim không trùng với public beta contract.

Đây không chỉ là lỗi tài liệu. Người mới gặp một trong các lệch này sẽ mất niềm
tin vào toàn bộ setup.

### 3.6 Integration Eraser có ý tưởng tốt nhưng tín hiệu đang bị nhiễu

Khi chạy read-only scanner trên một ứng dụng NestJS/BullMQ thật, scanner tìm
được status route, polling hook, BullMQ listener, upload proxy và retry timer.
Đó là hướng giá trị tốt: cho người dùng biết RhinoQ có thể xóa plumbing nào.

Nhưng kết quả cũng có các vấn đề:

- chạm giới hạn 200 findings;
- đưa cả blank line, DTO và file không liên quan vào evidence;
- quét nested checkout, source RhinoQ, test/generated/vendor-like content;
- dùng vocabulary quá rộng nên confidence bị thổi phồng;
- summary không đủ nổi bật so với danh sách finding;
- mới nhận ra một phần queue và producer;
- dù không biết Task semantics, next action vẫn gợi ý `single --apply`.

Một công cụ migration có false positive cao làm người dùng sợ hơn là giúp họ.
Scanner phải đáng tin trước khi trở thành hero command trong README.

### 3.7 Sản phẩm sâu hơn trải nghiệm vào cửa

Workbench đã có nền cho progress, Incident Flight Recorder, compare attempts,
Rule testing, Safe Bulk Actions, saved views, shareable filters và realtime.
Đây là tài sản tốt. Vấn đề là người mới không đi tới được các màn hình đó đủ
nhanh, và website/README chưa kể câu chuyện theo trình tự người dùng.

Nói cách khác:

> RhinoQ hiện có nhiều “lý do để ở lại”, nhưng chưa có một “lý do để thử ngay”
> đủ ngắn và chắc chắn.

## 4. Funnel rời bỏ hiện tại

| Giai đoạn | Người dùng muốn biết | Trải nghiệm hiện tại | Lý do có thể bỏ cuộc |
|---|---|---|---|
| 10 giây đầu | Nó giúp tôi việc gì? | mô tả rất rộng | chưa thấy outcome cụ thể |
| 30 giây đầu | Nó hơn dashboard queue ở đâu? | nhiều capability chuyên sâu | nghe giống platform lớn, khó áp dụng |
| 2 phút | Tôi thử mà chưa cài DB được không? | chưa có demo local không hạ tầng | bị chặn bởi Docker/PostgreSQL |
| 5 phút | Tôi có thấy Task chạy không? | `eval` chỉ in PASS rồi đóng server | không có khoảnh khắc trực quan |
| 10 phút | Tôi giữ BullMQ được không? | có, nhưng nằm giữa nhiều khái niệm | tưởng phải thay worker/runtime |
| 15 phút | Tôi thêm một Task thế nào? | nhiều API và đường tích hợp | không rõ golden path duy nhất |
| Sau tích hợp | Frontend nhận gì? | contract có nhưng ví dụ phân tán | tự viết lại polling/status UI |
| Khi lỗi | Tôi xử lý an toàn thế nào? | tính năng sâu đã có nền | chưa kết nối liền mạch từ first run |

## 5. Người dùng ưu tiên và “job to be done”

### 5.1 Persona ưu tiên số một: ứng dụng Node/NestJS đã có worker

Họ đã có BullMQ, SQS hoặc runtime riêng. Họ không muốn thay queue. Họ muốn:

- endpoint trạng thái cho user;
- tiến độ thật;
- hủy/thử lại đúng quyền;
- lịch sử attempt;
- kết quả/file đầu ra;
- UI không phải tự xây;
- giải thích khi worker xanh nhưng kết quả nghiệp vụ sai.

Đây là wedge tốt nhất vì RhinoQ có thể bổ sung một lớp sản phẩm quanh hệ thống
đang chạy, thay vì cạnh tranh bằng cú pháp enqueue ngắn hơn.

### 5.2 Persona số hai: ứng dụng mới cần background task

Họ muốn một starter chạy thật và một API ngắn. Họ không muốn chọn engine, rule,
effect policy hoặc transport ở bước đầu. Với họ, RhinoQ cần có default an toàn
và một template có handler thật.

### 5.3 Persona số ba: operator/support

Họ cần tìm Task, hiểu chuyện gì xảy ra, so sánh attempt, xem evidence và thực
hiện hành động có guardrail. Workbench phục vụ persona này, nhưng nó không nên
chiếm toàn bộ phần mở đầu dành cho developer mới.

### 5.4 Persona số bốn: end user

Họ chỉ cần biết tác vụ của mình đang ở đâu, tiến độ, kết quả, lỗi có thể hiểu,
và action được phép. Task Center phải là outcome đầu tiên trong demo, không phải
phụ lục sau operator Workbench.

## 6. Ngân sách đơn giản bắt buộc

Trước lần chạy thành công đầu tiên, người dùng chỉ nên cần hiểu bốn khái niệm:

1. **Task**: việc bất đồng bộ mà người dùng quan tâm;
2. **worker/runtime**: nơi công việc đang được thực hiện, có thể giữ nguyên;
3. **progress/result**: dữ liệu user nhìn thấy;
4. **RhinoQ state store**: trạng thái bền dùng cho API và UI.

Ngân sách interface mục tiêu:

| Thành phần | Mục tiêu golden path |
|---|---|
| Package chính | một package được khuyến nghị |
| CLI | một tên lệnh |
| Biến môi trường local | không có ở demo; tối đa một ở real setup |
| UI entry | một landing page dẫn tới Task Center và Workbench |
| Lệnh để thấy giá trị | một lệnh |
| Lựa chọn bắt buộc | chỉ hỏi khi không thể suy ra an toàn |
| Khái niệm trước first run | tối đa bốn |
| Advanced features trong README | chỉ một dòng + link |

Rule, Finding, Effect, reconciliation, evidence passport, fencing, checkpoint,
Autopilot và module lifecycle chỉ xuất hiện sau mục “Bạn đã chạy Task đầu tiên”.

## 7. Golden path mục tiêu

### 7.1 Chỉ muốn xem RhinoQ: không DB, không Redis, không token

**Đề xuất command:**

```bash
npx rhinoq dev --demo
```

Hành vi bắt buộc:

1. khởi động demo store giới hạn trong process hoặc fixture đóng gói;
2. chọn port trống;
3. tự mở browser;
4. hiện một Task đang chạy từ 0 đến 100;
5. hiện một Task hoàn thành có kết quả tải/xem được;
6. hiện một Task lỗi có attempt history;
7. cho thử cancel, retry/recheck ở phạm vi demo;
8. ghi rõ “demo data, không kết nối provider”;
9. in một lệnh duy nhất để chuyển sang integration thật;
10. Ctrl+C phải dọn sạch process và dữ liệu tạm.

Không được giả ETA. Nếu demo muốn minh họa progress thì fixture phải thực sự
phát các bản ghi progress theo thời gian.

### 7.2 Muốn chạy local stack thật

**Đề xuất command:**

```bash
npx rhinoq up
```

Hành vi bắt buộc:

- kiểm tra Docker;
- chọn port an toàn;
- dùng đúng PostgreSQL version đã công bố/test;
- start container;
- chờ healthcheck;
- migrate schema;
- sinh credential local ngẫu nhiên;
- tạo fixture thật;
- mở landing page;
- in trạng thái từng bước và rollback/cleanup command;
- chạy lại phải idempotent.

Người dùng không nên tự nối năm command plumbing chỉ để xem UI.

### 7.3 Có ứng dụng BullMQ/NestJS hiện hữu

**Đề xuất command:**

```bash
npx rhinoq connect
```

Luồng wizard dùng ngôn ngữ đời thường:

1. “Một hành động của user tạo một job hay nhiều job?”
2. “Field nào là owner/user id?”
3. “Queue nào muốn đưa vào Task Center?”
4. “Giữ nguyên BullMQ worker chứ?” — mặc định có.
5. preview file và diff;
6. apply không overwrite;
7. chạy verification;
8. mở một Task thật trong Task Center.

Nếu scanner không chắc single/fan-out, wizard phải hỏi. Không được tự chọn để
giảm một câu hỏi.

### 7.4 Tạo Task mới

**Đề xuất command:**

```bash
npx rhinoq add task report.export
```

Nó nên sinh một vertical slice tối thiểu:

- task definition;
- typed input/result;
- handler;
- progress example;
- dispatch route hoặc framework hook;
- worker registration;
- test chạy độc lập trên manifest/plan;
- link Task Center;
- TODO rõ cho auth và business-specific result.

Generator phải có smoke test chạy ngay để kiểm tra manifest/plan; dispatch thật
chỉ được bật sau khi ứng dụng thay manual adapter bằng runtime đã đăng ký.

## 8. Viết lại README

### 8.1 Vai trò mới của README

README chỉ cần làm năm việc:

1. nói RhinoQ giải quyết vấn đề gì;
2. cho xem sản phẩm;
3. cho thử nhanh;
4. chỉ đường tích hợp ngắn nhất;
5. nói thật status và giới hạn.

README không nên là API reference, architecture handbook, production manual và
roadmap cùng lúc.

### 8.2 Mục tiêu kích thước và thứ tự

**Đề xuất:** README chính khoảng 180–300 dòng, 1.500–2.500 từ và không quá 8
section cấp hai. Đây là budget sản phẩm, không phải cắt chữ cơ học.

Cấu trúc đề xuất:

1. Hero: một câu giá trị, status beta, một ảnh hoặc GIF ngắn;
2. “Try it in 60 seconds”: `npx rhinoq dev --demo`;
3. “Add it to an existing worker”: một ví dụ BullMQ/NestJS ngắn;
4. “What you get”: Task API, Task Center, Workbench, progress/result/cancel;
5. “Choose a runtime”: keep BullMQ, native PostgreSQL, custom adapter;
6. “When RhinoQ is/not a fit”;
7. “Production status”;
8. Documentation map.

### 8.3 Nội dung phải chuyển khỏi README

Chuyển sang docs chuyên sâu:

- effect ledger và unknown external result;
- outcome verification internals;
- Rule/Verifier/Findings contract đầy đủ;
- fencing, lease và retry correctness;
- realtime transport internals;
- multipart/data-path details;
- checkpoints;
- Autopilot;
- module lifecycle;
- capability ledger;
- retention;
- multi-tenant deployment boundary;
- benchmark/fault evidence;
- recovery protocol chi tiết;
- full API examples.

README chỉ giữ một câu outcome cho mỗi nhóm và link đến tài liệu tương ứng.

### 8.4 Nội dung phải bỏ hoặc sửa ngay

- bỏ command `create-rhinoq-app` nếu package chưa được release-test;
- không nói setup “one-command” khi user vẫn phải tự start DB, set env và mở UI;
- không để version beta.20 tồn tại cạnh beta.21;
- không nói S3 SDK “ships” nếu package manifest không thực sự cài dependency;
- không dùng PostgreSQL 17 trong generator khi contract công khai là 16;
- không đưa hai package ngang hàng ở phần đầu; chọn một canonical package;
- không lặp Quick start/New here/Start here/demo thành nhiều entry point;
- không đưa Go agent tenancy boundary trước first install;
- không so sánh BullMQ bằng ví dụ cố ý dài hoặc không cùng outcome.

### 8.5 Bản mở đầu README đề xuất

Nội dung minh họa, chỉ dùng sau khi command demo tương ứng đã có code và test:

````md
# RhinoQ

Add a user-facing Task API and UI to background work without replacing your
worker.

- Keep BullMQ, use RhinoQ's PostgreSQL queue, or connect a custom runtime.
- Show real progress, results, cancellation and attempt history.
- Give users a Task Center and operators a Workbench.

Public beta for evaluation and controlled pilots. No production SLA is claimed.

## Try RhinoQ

```bash
npx rhinoq dev --demo
```

The browser opens with a running Task, a completed result and a failed attempt.
No database or Redis is required for this demo.
````

Không được đưa đoạn này vào README trước khi behavior đúng như mô tả.

## 9. Kiến trúc tài liệu mới

### 9.1 Information architecture

```text
README
├─ 60-second demo
├─ Existing BullMQ/NestJS integration
├─ New app / PostgreSQL queue
├─ Concepts
│  ├─ Task vs Execution
│  ├─ progress, result and cancellation
│  └─ uncertainty and verification
├─ Product surfaces
│  ├─ Task Center
│  ├─ Workbench
│  └─ React/API integration
├─ Operations
│  ├─ deployment
│  ├─ security/tenancy
│  ├─ recovery
│  └─ retention/observability
└─ Reference
   ├─ CLI
   ├─ Node API
   ├─ Go API
   └─ contracts and architecture
```

### 9.2 Quy tắc một nguồn sự thật

- version lấy từ release metadata/package manifest;
- PostgreSQL support matrix có một nguồn;
- package canonical có một nguồn;
- CLI help và docs được kiểm tra từ executable, không copy thủ công dài hạn;
- command trong README chạy trong clean-room CI trên Windows và Linux;
- tiếng Việt và tiếng Anh có cùng golden path/version;
- website lấy capability/status từ cùng nguồn với README hoặc build metadata;
- tính năng chưa có code/test phải ghi roadmap, không ghi current capability.

### 9.3 Progressive disclosure

Mỗi guide chỉ giải thích khái niệm cần cho bước đang làm. Ví dụ:

- quickstart không dạy Effect Ledger;
- BullMQ integration không dạy native PostgreSQL worker internals;
- Task Center guide không mở đầu bằng operator recovery;
- production guide mới đưa tenancy, retention, fault drill và evidence policy.

## 10. CLI cần được thiết kế lại theo mục tiêu người dùng

### 10.1 Help mặc định

`npx rhinoq --help` hiện trộn setup, adoption, Rule, notification, Failure Lab,
capability ledger, module lifecycle, plan, measure và demo. Help mặc định nên chỉ
có:

```text
Start
  rhinoq demo       See RhinoQ without infrastructure
  rhinoq up         Start a real local stack
  rhinoq connect    Add RhinoQ to an existing app
  rhinoq add task   Create one working Task slice

Use
  rhinoq dev        Open the local product surface
  rhinoq doctor     Diagnose the current project

More
  rhinoq help rules
  rhinoq help operations
  rhinoq help advanced
```

### 10.2 Doctor có khả năng sửa local an toàn

**Đề xuất:** `rhinoq doctor --fix` chỉ tự sửa các việc reversible, local và đã
preview:

- tạo file env local từ template bằng secret ngẫu nhiên;
- chọn port trống;
- phát hiện Docker chưa chạy và in action cụ thể;
- sửa version config generated cũ;
- tạo missing local compose;
- chạy schema migration sau confirmation.

Không được sửa business mapping, Task semantics, auth hoặc production secret.

### 10.3 Error phải giữ context và đưa đúng một next action

Thay vì in nhiều scheme biến môi trường, lỗi first-run nên nói:

```text
RhinoQ needs PostgreSQL for a real local Task.

Fastest fix:
  npx rhinoq up

Already have PostgreSQL?
  set RHINOQ_DATABASE_URL and rerun this command
```

Thông tin PGHOST/PGDATABASE chi tiết nằm trong `help database`.

## 11. API/DX cần ngắn theo outcome, không che correctness

### 11.1 Dispatch phải trả về một run handle dùng được ngay

Developer không nên lấy một snapshot rồi tự ghép URL, polling, cancel và result
client. API mục tiêu có thể theo dạng:

```ts
const run = await tasks.reportExport.start({ reportId });

run.id;
run.url;
await run.snapshot();
await run.cancel();
const result = await run.wait();
```

Hoặc API tương đương miễn là đáp ứng cùng outcome. `run.wait()` phải có timeout,
AbortSignal và không biến polling thành source of truth khác.

### 11.2 Common path ngắn, dangerous path phải rõ

Common Task an toàn nên cần ít config. Nhưng external effect nguy hiểm vẫn phải
khai báo idempotency/confirmation policy. Không làm ngắn code bằng cách:

- giấu `uncertain`;
- retry unknown result;
- bỏ owner/tenant boundary;
- chuyển lease/retry/state correctness sang SDK;
- tự chạy job name worker chưa đăng ký;
- mặc định một recovery handler không được app đăng ký.

### 11.3 Framework starter phải là vertical slice

Cần template được test cho ít nhất:

- Node HTTP framework-neutral;
- NestJS + BullMQ hiện hữu;
- Node + native PostgreSQL queue;
- owner Task Center trong React/Next.js.

Mỗi template phải có handler thật, progress thật, result thật, test thật và
route/UI thật. Sample không được chỉ mount middleware rồi để người dùng tự đoán
phần còn lại.

## 12. Website phải chứng minh outcome trước capability

### 12.1 Hero

Hero cần trả lời ngay:

- giữ queue/worker được không? Có;
- user nhận được gì? Task API + UI + progress/result/cancel/history;
- thử bằng cách nào? một demo command;
- sản phẩm đang ở status nào? public beta/controlled pilots.

### 12.2 Comparison page

Không so “số dòng queue.add” với BullMQ nếu hai đoạn code không cùng outcome.
So sánh phải theo user outcome:

| Outcome | BullMQ thuần | BullMQ + RhinoQ |
|---|---|---|
| Chạy/retry job | BullMQ làm tốt | giữ nguyên BullMQ |
| Owner-scoped status API | app tự xây | RhinoQ cung cấp contract |
| Task Center | app tự xây | RhinoQ mount/cấu hình |
| Progress realtime | app tự nối | RhinoQ cung cấp path chuẩn |
| Attempt/evidence history | app tự tổng hợp | Workbench tổng hợp |
| Safe recovery | runbook app tự xây | preview/approve/verify có guardrail |

Nếu BullMQ tốt hơn ở queue-only use case, phải nói thẳng. Sự trung thực làm
khác biệt RhinoQ đáng tin hơn.

### 12.3 Playground

Playground phải chạy cùng contract với sản phẩm hoặc ghi rõ là interactive
mock. Người dùng cần:

- start một Task;
- nhìn progress tăng;
- cancel;
- xem result;
- gây một failure có kiểm soát;
- mở Workbench ở đúng Task;
- copy code tương ứng với hành động vừa thử.

### 12.4 Nội dung website phải được đồng bộ

- version, release status, package name và PostgreSQL version lấy từ build data;
- không dùng claim production-ready khi README nói public beta;
- không hiển thị API/command chưa tồn tại;
- không dùng code comparison dài để tạo lợi thế thị giác giả;
- mọi CTA dẫn đến đúng một golden path còn hoạt động.

## 13. Task Center và Workbench: thứ tự nâng cấp

### 13.1 P0 — thấy giá trị tức thì

Task Center cần ưu tiên:

1. tên Task bằng ngôn ngữ nghiệp vụ;
2. trạng thái dễ hiểu;
3. progress thật hoặc “Không có dữ liệu tiến độ”;
4. bước đang xử lý;
5. cập nhật lần cuối;
6. kết quả/file;
7. cancel/retry theo capability;
8. “Xem chi tiết kỹ thuật” là progressive disclosure.

Workbench cần ưu tiên:

1. search Task/job/user/correlation;
2. saved/shareable view;
3. danh sách không tràn ở màn hình hẹp;
4. panel detail resize được;
5. tiêu đề và content hierarchy rõ;
6. empty state có next action;
7. dữ liệu nhỏ nhất vẫn đọc được ở zoom/màn hình thực tế.

### 13.2 P1 — điều tra và hành động an toàn

Các slice đã có nền cần hoàn thiện thành workflow liền mạch:

- Task progress có source/timestamp và không đoán ETA;
- Incident Flight Recorder nối queue wait, attempts, effects, outcomes,
  findings và recovery decision;
- compare attempt trước/sau;
- Rule Console mở được từng Rule, test subject, lý do finding, sample có giới
  hạn, version history, open finding count và last run;
- `Run now` luôn preview trước và không cho SQL tùy ý;
- Safe Bulk Actions phân Safe/Uncertain/Blocked, approval riêng, chỉ chạy
  registered handler và verify lại;
- realtime dùng source of truth hiện có, có polling fallback và báo stale state;
- saved views local rõ phạm vi; shared URL không để lộ secret/filter nhạy cảm.

### 13.3 P2 — lợi thế vận hành

Sau khi first-run và workflow P1 ổn định mới đẩy mạnh:

- outcome verification theo business rule;
- provider evidence/readback;
- uncertainty-first recovery;
- cross-attempt/cross-effect investigation;
- bounded autopilot cho action đã phê duyệt;
- evidence passport/export phục vụ audit;
- multi-environment/control-plane chỉ khi có evidence và support boundary.

## 14. Integration Eraser v2

Scanner cần chuyển từ “tìm càng nhiều càng tốt” sang “tìm ít nhưng đáng tin”.

### 14.1 Default scope

Loại mặc định:

- `.git`, `node_modules`, build output, coverage, fixtures lớn;
- nested repository;
- generated files;
- vendor source;
- chính source RhinoQ;
- test snapshots nếu không bật flag.

Tôn trọng `.gitignore` và cho phép `.rhinoqignore`.

### 14.2 Output summary-first

Mặc định chỉ in:

```text
Detected
  BullMQ: 4 queues, 7 producers, 5 workers
  Status APIs: 3
  Polling/reconnect implementations: 2
  Retry/recovery handlers: 1

High-confidence replacement candidates
  6 files · 31 lines

Needs a decision
  bulk-export may be fan-out
  owner identity not proven
```

`--all` mới in review findings. `--json` giữ evidence machine-readable.

### 14.3 Detection quality

- ưu tiên AST/import/call graph hơn keyword;
- blank line không bao giờ là evidence;
- một finding phải có symbol/call/route cụ thể;
- confidence phải giải thích được;
- queue, producer, worker và status route phải nối thành graph;
- không gợi ý apply khi semantics hoặc owner mapping chưa rõ;
- generated diff phải nhỏ, reversible và không overwrite.

## 15. Một package, một UI, một ngôn ngữ sản phẩm

### 15.1 Package

Chọn `@rhinoq/node` làm package canonical trong code và docs. Alias `rhinoq` có
thể tồn tại cho CLI ngắn, nhưng không giải thích hai package ngang hàng trong
hero/quickstart.

### 15.2 UI entry

Node và Go có thể có implementation boundary khác nhau, nhưng người dùng cần
một mental model:

```text
/rhinoq
├─ My tasks / Task Center
└─ Operations / Workbench
```

Port có thể cấu hình, nhưng command local phải in/open một landing URL thống
nhất. Không bắt người mới nhớ 8787 so với 8788.

### 15.3 Thuật ngữ

Ngôn ngữ hiển thị cần nhất quán:

- Task = việc người dùng quan tâm;
- Execution/Attempt = lần kỹ thuật thực hiện Task;
- Rule = điều kiện kiểm chứng;
- Finding = vấn đề Rule phát hiện;
- Recovery = hành động có kiểm soát để xử lý vấn đề.

Lifecycle COMMIT/RUN/VERIFY/RECOVER là lens vận hành, không được trình bày như
phần trăm tiến độ. Progress chỉ đến từ dữ liệu worker/application thực sự ghi.

## 16. Backlog hợp nhất

### P0 — phải hoàn thành trước khi tăng traffic vào README/website

| ID | Việc cần sửa | Kết quả bắt buộc |
|---|---|---|
| FTV-001 | Viết lại README theo cấu trúc mục 8 | first command nằm trong màn hình đầu; không còn entry point trùng |
| FTV-002 | `dev --demo` không hạ tầng | browser mở và có Task progress/result/failure tương tác được |
| FTV-003 | Làm `up` thành orchestration thật | DB, migrate, fixture, UI chạy bằng một command |
| FTV-004 | Sửa version/source-of-truth | không còn beta.20; PG version đồng nhất; website đúng status |
| FTV-005 | Sửa hoặc gỡ `create-rhinoq-app` | clean install test chứng minh app chạy; nếu chưa có thì không claim |
| FTV-006 | Sửa report-export generator | `.env` hoạt động, handler/dispatch/progress/result thật, browser auth dùng được |
| FTV-007 | Fail-closed setup/adopt semantics | unknown single/fan-out thành `needs decision` |
| FTV-008 | Chọn package và UI entry canonical | một install path, một landing URL |
| FTV-009 | Đồng bộ README Node SDK/S3 dependency | docs đúng với package manifest |
| FTV-010 | Clean-room docs test | Windows/Linux chạy toàn bộ quickstart từ máy sạch |

### P1 — làm DX hằng ngày tốt hơn rõ rệt

| ID | Việc cần sửa | Kết quả bắt buộc |
|---|---|---|
| DX-001 | `connect` wizard | giữ runtime, hỏi semantics/owner khi chưa chắc, preview-first |
| DX-002 | `add task` vertical-slice generator | một Task mới chạy end-to-end, có test và UI link |
| DX-003 | user-facing run handle | start/snapshot/wait/cancel/result/url không cần tự ghép plumbing |
| DX-004 | progressive CLI help | default help chỉ có start/use; advanced theo namespace |
| DX-005 | `doctor --fix` an toàn | tự sửa local plumbing; không đoán business/security |
| DX-006 | Integration Eraser v2 | summary-first, high precision, loại nested/generated/vendor |
| DX-007 | framework starters | Node, NestJS/BullMQ, PostgreSQL queue, React owner UI |
| DX-008 | error UX | một primary next action, context giữ nguyên, advanced help riêng |
| DX-009 | UI onboarding checklist | từ empty state tới Task thật không cần đọc docs dài |
| DX-010 | API/examples diet | common path ngắn; advanced correctness vẫn explicit |

### P1 — hoàn thiện workflow sản phẩm đã có nền

| ID | Việc cần sửa | Kết quả bắt buộc |
|---|---|---|
| UI-001 | Task progress | dữ liệu thật, timestamp/source, không đoán ETA, empty state rõ |
| UI-002 | Flight Recorder | nối queue/attempt/effect/outcome/finding/recovery theo thời gian |
| UI-003 | Attempt comparison | trước/sau dễ đọc và chỉ ra field thay đổi |
| UI-004 | Rule Console | click từng Rule, test preview, reason, sample bounded, history |
| UI-005 | Safe Bulk Actions | preview, group, approve, registered handler, post-verify |
| UI-006 | Responsive/resizable layout | không tràn chữ, panel kéo rộng, keyboard và mobile/zoom test |
| UI-007 | Saved/shared views | filter state rõ, URL share an toàn, scope lưu trữ minh bạch |
| UI-008 | Realtime health | SSE/fallback/staleness hiển thị được, không tạo source of truth thứ hai |
| UI-009 | Visual hierarchy/accessibility | font dễ đọc, heading nổi bật, semantic colors, focus/contrast đạt chuẩn |
| UI-010 | Rule/list navigation | hàng/card có affordance và deep link ổn định |

### P2 — khác biệt cạnh tranh sau khi P0/P1 qua gate

| ID | Việc cần sửa | Điều kiện bắt đầu |
|---|---|---|
| MOAT-001 | Outcome verification templates | golden path và Rule Console đã ổn định |
| MOAT-002 | Provider evidence adapters | có idempotency/confirmation contract và fault evidence |
| MOAT-003 | Evidence Passport | source data ổn định, export không lộ secret |
| MOAT-004 | Guarded Autopilot | action app-owned, canary/approval/rollback có test |
| MOAT-005 | Optional control plane | multi-environment demand và security model đã được chứng minh |

## 17. Trình tự thực hiện

### Phase A — sửa product truth

1. chốt package/version/PostgreSQL support source;
2. sửa generator và claim sai;
3. thêm clean-room checks;
4. dọn website metadata;
5. chỉ sau đó mới viết copy mới.

Lý do: không nên làm README hấp dẫn hơn rồi đẩy người dùng vào command hỏng.

### Phase B — tạo first-value loop

1. `dev --demo`;
2. landing UI thống nhất;
3. Task progress/result/failure demo;
4. CTA sang `up` hoặc `connect`;
5. browser acceptance test.

### Phase C — viết lại README và website

1. thay hero;
2. đưa demo lên đầu;
3. giữ một existing-app path;
4. chuyển advanced content vào docs;
5. viết comparison theo outcome;
6. đồng bộ tiếng Việt/Anh.

### Phase D — rút ngắn adoption thật

1. Integration Eraser v2;
2. `connect` wizard;
3. `add task`;
4. run handle;
5. framework starters;
6. pilot trên repository ngoài RhinoQ.

### Phase E — hoàn thiện operator moat

1. Flight Recorder;
2. Rule Console;
3. Safe Bulk Actions;
4. evidence/recovery loop;
5. đo task-resolution outcome thay vì chỉ đếm feature.

## 18. Tiêu chí nghiệm thu

### 18.1 README

- người chưa biết RhinoQ nói lại được giá trị bằng một câu sau 30 giây;
- command đầu tiên xuất hiện trước capability matrix;
- không cần hiểu Rule/Effect/Finding để chạy demo;
- không có command/version/package không được release-test;
- không có hai quickstart cạnh tranh;
- tất cả local links tồn tại;
- public beta và giới hạn production rõ nhưng không che mất quickstart.

### 18.2 Demo

- chạy được từ thư mục trống với Node version hỗ trợ;
- không yêu cầu DB/Redis/token;
- tự mở browser hoặc in một URL duy nhất khi auto-open không khả dụng;
- có progress thật, result thật trong phạm vi fixture và một failure thật trong
  phạm vi demo;
- cancel/retry không ảnh hưởng hệ thống ngoài;
- dừng không để process/container/file rác ngoài phạm vi đã công bố.

### 18.3 Local real stack

- một command từ máy có Docker tới UI có dữ liệu;
- rerun an toàn;
- port conflict được xử lý;
- migration/version mismatch có next action;
- PostgreSQL version trùng support matrix;
- cleanup chính xác và có thể dự đoán.

### 18.4 Existing app adoption

- không thay worker/runtime nếu người dùng không chọn;
- không tự đoán single/fan-out;
- không overwrite file;
- preview hiển thị file, diff, queue, owner mapping và giới hạn;
- scanner không quét nested/generated/vendor theo default;
- high-confidence finding có symbol/line evidence;
- sau apply có ít nhất một Task thật mở được trong UI;
- reverse patch/rollback được test.

### 18.5 API/DX

- use case start → progress → result → cancel không cần app tự viết polling;
- handler chưa đăng ký không được thực thi;
- unknown external result không retry mù;
- owner/tenant auth fail-closed;
- run handle có timeout/abort và typed result;
- common sample ngắn hơn app tự xây cùng outcome, đo bằng file/line thực tế chứ
  không dùng đoạn so sánh dàn dựng.

### 18.6 UI

- 320 px, 768 px, desktop và zoom 200% không tràn nội dung quan trọng;
- keyboard focus, dialog, resize handle và row navigation hoạt động;
- font body/metadata đạt ngưỡng đọc được đã định trong design tokens;
- status không chỉ phân biệt bằng màu;
- lifecycle không bị hiểu nhầm là progress;
- thiếu progress hiển thị unavailable, không tạo ETA;
- bulk action không chạy trước preview và approval;
- Rule run là preview, không nhận arbitrary SQL từ browser.

## 19. Đo lường để biết người dùng có thật sự thấy dễ hơn

Các con số dưới đây là **mục tiêu sản phẩm cần kiểm chứng**, không phải claim
hiện tại:

| Metric | Cách đo |
|---|---|
| Time to visible value | từ command đầu tới lúc browser có Task đang đổi trạng thái |
| Time to existing-worker integration | từ clone app pilot tới Task thật đầu tiên trong Task Center |
| First-run completion rate | tỷ lệ người thử hoàn thành demo mà không cần hỗ trợ |
| Concepts before success | số thuật ngữ cần giải thích trước khi Task đầu tiên chạy |
| Commands before success | số command người dùng phải tự nhập |
| Setup decision accuracy | tỷ lệ runtime/mode/owner mapping đúng, không cần rollback |
| Scanner precision | high-confidence findings được adopter chấp nhận / tổng high-confidence |
| Plumbing removed | file/line app-owned được xóa cho cùng outcome, đo trước/sau |
| UI task success | tỷ lệ tìm Task, hiểu lỗi, tải result, cancel hoặc recheck thành công |
| Support demand | số lần người thử phải hỏi về DB, package, port, auth và terminology |

Pilot usability tối thiểu nên có:

- một developer chưa từng thấy RhinoQ;
- một developer có app BullMQ;
- một operator/support user;
- một người chỉ dùng Task Center;
- screen recording, command log và câu hỏi think-aloud;
- không hướng dẫn ngoài README trong vòng đầu.

## 20. Những claim chưa được phép dùng

Không được quảng bá các câu sau nếu chưa có code và evidence tương ứng:

- “one command setup” khi còn manual step bắt buộc;
- “runs a real batch” khi generator chỉ mount UI;
- “drop-in replacement” cho BullMQ;
- “production-ready” hoặc SLA;
- throughput/latency nhanh hơn đối thủ nếu benchmark không cùng workload;
- “zero config” nếu auth, owner hoặc semantics vẫn cần quyết định;
- “no polling” khi fallback vẫn tồn tại;
- “S3 SDK included” nếu npm dependency contract không đúng;
- “automatic recovery” khi action chưa được app đăng ký/approve/verify;
- ETA nếu source không cung cấp dữ liệu tiến độ đủ tin cậy.

## 21. Quyết định sản phẩm cần chốt

Các đề xuất mặc định trong kế hoạch này:

1. `@rhinoq/node` là package canonical; `rhinoq` chỉ là alias tiện dụng;
2. existing-worker adoption là hero path thương mại đầu tiên;
3. Task Center là first-value surface; Workbench là depth surface;
4. demo không hạ tầng là mô phỏng có nhãn rõ; `up` mới là local stack thật;
5. PostgreSQL support version theo ma trận test công khai, không theo image mới
   nhất ngẫu nhiên;
6. unknown semantics luôn cần quyết định;
7. README là landing/onboarding contract, không phải toàn bộ manual;
8. advanced correctness vẫn explicit, không hy sinh an toàn để giảm số dòng.

Nếu thay đổi một quyết định trên, cần cập nhật golden path và acceptance test
tương ứng, không chỉ sửa copy.

## 22. Definition of Done toàn chương trình

Chương trình chỉ hoàn thành khi đồng thời có:

- README mới ngắn, có một entry point và mọi command chạy được;
- demo không hạ tầng cho người dùng thấy Task thật thay đổi trong browser;
- local stack thật khởi động bằng một command;
- generator tạo vertical slice chạy end-to-end;
- setup/adopt không đoán business semantics;
- Integration Eraser có precision đủ để adopter tin preview;
- package/version/support matrix đồng nhất trên repo, npm docs và website;
- existing BullMQ app giữ nguyên worker nhưng có Task API/UI/progress/result;
- run handle giảm plumbing mà không làm yếu correctness contract;
- Task Center/Workbench responsive, dễ đọc và có workflow liền mạch;
- browser, CLI, contract, security và clean-room doc tests đều qua;
- usability pilot chứng minh người mới hoàn thành first run không cần người trong
  team giải thích;
- mọi claim trên website có link tới code/test/evidence hoặc được ghi rõ roadmap.

Đích cuối cùng không phải README ít chữ hơn. Đích là người dùng hiểu đúng sản
phẩm nhanh hơn, nhìn thấy giá trị trước khi phải học kiến trúc, và có thể đưa
RhinoQ vào một ứng dụng thật mà không giao lại cho họ chính phần plumbing RhinoQ
hứa sẽ loại bỏ.
