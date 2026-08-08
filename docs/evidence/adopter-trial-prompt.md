# Prompt: gắn RhinoQ vào một dự án đang chạy, và xem nó phơi ra những gì

Dán nguyên khối dưới đây cho agent. Thay `<ĐƯỜNG_DẪN_DỰ_ÁN>` bằng repo thật.

---

Bạn là backend developer của ứng dụng tại `<ĐƯỜNG_DẪN_DỰ_ÁN>`. Ứng dụng đang
chạy production: NestJS + PostgreSQL + BullMQ + Redis.

Bạn có **hai** việc, và việc thứ hai quan trọng hơn:

1. Gắn RhinoQ vào một luồng nền đang có — không đập đi làm lại, không dừng
   tính năng nào.
2. **Lập danh mục mọi thứ RhinoQ phơi ra về code hiện tại.** RhinoQ ghi lại
   điều gì *thật sự* xảy ra với từng item. Code hiện tại ghi lại điều nó *tin
   là* đã xảy ra. Mỗi chỗ hai bên lệch nhau là một bug đang sống trong
   production ngay lúc này.

Bạn không phải người viết RhinoQ. Bạn không nợ nó lời khen nào. Nếu nó không
phơi ra được gì, đó cũng là một kết quả — và phải nói thẳng.

## Đọc trước, tiết kiệm hàng giờ

`examples/fanout-bullmq/` trong repo RhinoQ là một app Express + BullMQ +
PostgreSQL chạy được, có fan-out, tiến độ, huỷ và tín hiệu hoàn tất. README của
nó liệt kê ba cái bẫy đã được đo bằng cách chạy thật. Đọc nó trước khi viết
dòng nào. Tài liệu khác: `sdks/node/README.md`, `docs/feature-matrix.md`.

## Bước 0 — Viết `before.md` TRƯỚC khi cài

Bắt buộc. Không có file này thì mọi so sánh về sau đều vô nghĩa, vì viết sau
khi đã biết đáp án thì bao giờ cũng có lợi cho RhinoQ.

- Chọn **một** luồng nền có fan-out, tiến độ hoặc huỷ. Nói rõ vì sao chọn.
- Luồng đó chạy thế nào: bảng nào, khoá Redis nào, endpoint nào, file nào.
- **Code hiện tại TIN điều gì?** Viết thành khẳng định kiểm chứng được:
  - "job completed nghĩa là file đã nằm trên S3"
  - "counter Redis bằng total nghĩa là batch xong"
  - "job retry thì lần chạy thứ hai ghi đè lần đầu"
  - "user bấm huỷ thì mọi job dừng"
  Mỗi dòng là một giả định sẽ được đem ra đối chứng.
- **Chỗ nào bạn đã nghi là mong manh?** Ghi thẳng, kể cả chưa có bằng chứng.
- Việc tiếp theo bạn định làm trong luồng đó là gì?

## Bước 1 — Gắn vào

```bash
npm install @rhinoq/node pg
npx rhinoq-task     # tạo schema rhinoq_task, 3 bảng, KHÔNG đụng bảng cũ
npx rhinoq doctor
```

**Ràng buộc bắt buộc — vi phạm là hỏng đề bài:**

- **Không xoá code cũ.** Không xoá bảng, khoá Redis, endpoint đang có. Để hai
  bên cùng chạy — đó là điều kiện để đối chứng ở bước 2.
- **Không đổi API mà frontend đang gọi.** Nếu buộc phải đổi, đó là phát hiện.
- Luồng phải phục vụ người dùng được suốt quá trình.

Mount cả hai bề mặt HTTP:

```ts
// người dùng cuối: owner-scoped, không lộ job ID runtime
app.use(createNodeTaskMiddleware({ tasks, ownerFromRequest }));
// vận hành: đọc xuyên owner, hiện job ID BullMQ — để sau auth nội bộ
app.use(createNodeWorkbenchMiddleware({ tasks, requireOperator, basePath: '/admin/rhinoq' }));
```

**Bấm giờ.** Ghi mốc: lệnh đầu tiên, Task đầu tiên gắn vào luồng cũ, fan-out
chạy song song code cũ, console hiện dữ liệu, huỷ hoạt động, tín hiệu hoàn tất
bắn đúng một lần.

## Bước 2 — Đối chứng. Đây là phần chính.

Cho code cũ và RhinoQ **cùng quan sát một batch thật**, rồi soi từng chỗ lệch.
Với mỗi khẳng định trong `before.md`, tìm bằng chứng xác nhận hoặc bác bỏ.

Bảng phải điền, một dòng cho mỗi lần lệch:

| Code cũ tin | RhinoQ ghi nhận | Bên nào đúng | Tái hiện thế nào | Hậu quả với người dùng |
|---|---|---|---|---|

Những chỗ đáng soi nhất:

- Batch nào code cũ coi là xong mà RhinoQ vẫn thấy item đang mở?
- Counter Redis có bao giờ lệch `execution_succeeded + execution_failed` không?
  Ép 50+ item, nhiều worker, rồi so.
- Job retry: code cũ có ghi lại lần thử thứ nhất không, hay đè mất? RhinoQ
  đánh số attempt theo `itemKey` — dùng nó làm đối chứng.
- Có item nào **fail mà người dùng không bao giờ được báo**?
- Huỷ: RhinoQ nói mấy item thật sự dừng, code cũ nói mấy?
- Có bao nhiêu job "completed" mà kết quả thật sự không tồn tại? Đây là câu
  hỏi RhinoQ sinh ra để trả lời — dùng `attachTaskExecutionResult` rồi đếm
  `hasResult` so với số succeeded.

Chạy `npx rhinoq doctor` sau mỗi lần thử. Nó đọc hệ thống đang chạy: batch
đứng im, item terminal hết mà Task chưa đóng, attempt dispatched mà không ai
quan sát, có ai giữ projector lease không, projection failure tồn đọng. Mỗi
WARN là một câu hỏi về code của bạn.

## Bước 3 — Ép vào tình huống xấu

Đường hạnh phúc không phân biệt được RhinoQ với counter Redis tự viết. Counter
đó sai đúng ở những chỗ này:

- 50+ item, 2+ worker song song → tín hiệu hoàn tất bắn mấy lần? Counter cũ?
- Gửi lại sự kiện `completed` của cùng một job → bên nào double-fire?
- Kill worker giữa chừng rồi bật lại → bên nào treo, bên nào dọn?
- Kill process giữ projector lease → bên còn lại có tiếp quản không, và có
  process nào chạy song song mà không biết không?
- Huỷ batch đang chạy → mỗi bên tốn bao nhiêu query, huỷ được mấy phần?
- Cố tình bỏ `itemKey` → chặn, hay hỏng im lặng?

Một lần lệch quan sát được có giá trị hơn cả trang phân tích.

## Nhật ký ma sát — ghi liên tục, đừng để cuối mới nhớ lại

Mỗi lần kẹt: **kẹt ở đâu, mất bao lâu, gỡ ra bằng cách nào**. Hiểu sai tài liệu
cũng ghi. Đọc lại một đoạn hai lần cũng ghi. Phải mở source SDK ra đọc cũng ghi
— đó là tín hiệu mạnh rằng tài liệu thiếu.

Riêng với việc gắn vào code sẵn, ghi thêm:
- Chỗ nào RhinoQ **giả định** một thứ mà ứng dụng bạn làm khác?
- Chỗ nào phải viết adapter chỉ để hai bên nói chuyện được?
- Chỗ nào hai bên **trùng nhau** và bạn phải giữ đồng bộ bằng tay?

## Luật chống false green — vi phạm luật nào thì báo cáo mất giá trị

1. **Không kết luận từ type definition, doc comment hay tên hàm.**
   `onItemsSettled` tồn tại trong `.d.ts` không chứng minh nó bắn. Nó đã từng
   im lặng hoàn toàn trong một cấu hình hợp lệ, và mọi counter vẫn đúng.
2. **Xác minh đang chạy đúng bản SDK.** Số version không chứng minh nội dung:
   ```bash
   node -p "require('./node_modules/@rhinoq/node/dist/build-info.json')"
   ```
   Ghi `sourceHash` và `commit` vào đầu báo cáo.
3. **PostgreSQL, Redis, BullMQ worker phải là thật.** Không mock. Dùng đúng dữ
   liệu và cấu hình của ứng dụng.
4. **Ép concurrency, đừng chạy tuần tự.**
5. **Phân biệt hai profile.** Embedded PostgreSQL client và Gateway **không**
   có cùng bảo đảm per-item. Ghi rõ dùng cái nào.
6. **Ghi rõ cái KHÔNG kiểm.**

## Bước 4 — So với các lựa chọn khác, RhinoQ hơn và kém ở đâu

Bạn vừa dùng RhinoQ thật. Giờ đặt nó cạnh những thứ một team khác sẽ chọn cho
cùng bài toán. Không phải để xếp hạng — mà để trả lời: **khi nào nên dùng
RhinoQ, và khi nào nên dùng cái khác.**

Tối thiểu phải xét những nhóm này:

| Lựa chọn | Thuộc nhóm |
|---|---|
| Bull Board / Taskforce.sh | dashboard cho BullMQ |
| BullMQ Pro | bản trả phí của chính queue đang dùng |
| Temporal, Inngest, Trigger.dev | durable execution — thay cả mô hình chạy |
| pg-boss, Graphile Worker | queue chạy trên PostgreSQL |
| Tự viết | chính `before.md` của bạn |

Với **mỗi** lựa chọn, điền:

| | Nội dung |
|---|---|
| Nó giải quyết gì | một câu |
| RhinoQ làm TỐT HƠN ở đâu | cụ thể, không nói chung chung |
| RhinoQ làm KÉM HƠN ở đâu | bắt buộc phải có ít nhất một mục |
| Chi phí chuyển sang | phải viết lại bao nhiêu, có phải bỏ BullMQ không |
| Khi nào chọn nó thay RhinoQ | trường hợp cụ thể |

**Quy tắc trung thực, bắt buộc:**

- Đánh dấu mỗi khẳng định là **đã dùng thật**, **đọc tài liệu**, hay **suy
  đoán**. Ba mức, dùng đúng chữ. Một so sánh toàn mức "suy đoán" phải nói rõ là
  vô giá trị.
- Ô "kém hơn" trống là dấu hiệu bạn chưa nghĩ đủ, không phải RhinoQ hoàn hảo.
  Mỗi lựa chọn phải có ít nhất một điểm RhinoQ thua.
- Không so sánh thứ không cùng loại. Temporal thay cả cách viết code; RhinoQ
  gắn thêm vào code đang có. Nói rõ sự khác loại đó thay vì cho điểm.
- Xét cả những thứ RhinoQ **cố tình không làm**: nó không chạy job, không thay
  queue, không có scheduler, không có workflow/DAG. Đó là thiếu sót hay là
  ranh giới có chủ đích? Trả lời theo trải nghiệm của bạn, không theo lời
  quảng cáo của nó.

Rồi trả lời một câu duy nhất: **RhinoQ trả lời được câu hỏi nào mà những cái
kia không trả lời — và câu đó có đáng một dependency không?** Nếu câu trả lời
là "không có câu nào", nói thẳng.

## Câu hỏi phải trả lời

1. **RhinoQ phơi ra bao nhiêu vấn đề trong code hiện tại?** Liệt kê từng cái
   kèm cách tái hiện. Nói rõ cái nào **quan sát được** và cái nào chỉ **suy
   ra** — dùng đúng hai chữ đó.
2. Trong số đó, cái nào **đã ảnh hưởng người dùng thật** mà chưa ai biết?
3. **Gắn vào được không, thật sự?** Có phải viết lại phần nào không?
4. Việc tiếp theo trong `before.md` giờ làm có nhẹ hơn không? Làm thử một phần
   và đo, đừng đoán.
5. **Cái giá của việc chạy song song:** bảng thừa, khái niệm thừa, chỗ phải
   giữ đồng bộ bằng tay, query thêm.
6. **Rút ra được không?** Bỏ RhinoQ tuần sau thì mất bao lâu?
7. Chỗ nào tài liệu **nói sai** so với hành vi thật?
8. Nếu dừng giữa chừng vì thứ gì chặn đường — nêu chính xác thứ đó. Một bản
   tích hợp thất bại kèm lý do rõ ràng có giá trị hơn một bản thành công nửa
   vời được kể như trọn vẹn.
9. Có khuyên team gắn tiếp cho các luồng còn lại không? Theo thứ tự nào?
10. Với một team đang bắt đầu dự án mới hôm nay — họ nên chọn RhinoQ, một
    lựa chọn khác ở Bước 4, hay tự viết? Trả lời một lựa chọn, kèm lý do, và
    kèm điều kiện làm câu trả lời đổi chiều.

## Định dạng báo cáo

- Mở đầu bằng `sourceHash` và `commit` của SDK đã chạy.
- Mọi khẳng định kèm bằng chứng: lệnh đã chạy, output, hoặc file:line.
- Phân biệt rõ **đo được** với **suy ra**.
- Kèm `before.md`, bảng đối chứng và nhật ký ma sát nguyên văn, không biên tập.
- Kết thúc bằng "Những gì báo cáo này không chứng minh".

Đừng làm mượt kết luận. Nếu gắn RhinoQ vào đây không đáng, nói thẳng và nói
tại sao.
