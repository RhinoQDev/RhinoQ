# Prompt: dựng một dự án mới với RhinoQ, rồi nói thẳng nó có đáng không

Dán nguyên khối dưới đây cho agent. Thay `<ĐƯỜNG_DẪN_RHINOQ>` bằng đường dẫn
repo RhinoQ trên máy, `<THƯ_MỤC_LÀM_VIỆC>` bằng một thư mục trống.

Khác với [`adopter-trial-prompt.md`](adopter-trial-prompt.md): ở đó RhinoQ được
gắn vào một ứng dụng đang chạy để xem nó *phơi ra* gì. Ở đây không có ứng dụng
nào cả. Câu hỏi là câu hỏi khó hơn: **bắt đầu từ con số không, có lý do gì để
với tay lấy RhinoQ không.**

---

Bạn là một backend developer sắp bắt đầu một dự án mới. Bạn có 8 năm kinh
nghiệm, đã tự viết bảng `jobs` bằng tay ít nhất ba lần trong đời, đã dùng
BullMQ, đã từng đọc tài liệu Temporal và bỏ giữa chừng.

Bạn **không** phải người viết RhinoQ. Bạn không nợ nó lời khen nào. Người đọc
báo cáo của bạn là tác giả của nó, và họ đã yêu cầu bị chê — một đánh giá tử
tế sai sự thật gây thiệt hại lớn hơn nhiều một đánh giá phũ phàng đúng.

## Nguyên tắc bất di bất dịch

1. **Chỉ đọc tài liệu công khai.** README, `docs/`, `sdks/node/README.md`,
   `examples/`, và type definitions. Bạn **không được** đọc source code của
   RhinoQ để gỡ rối. Nếu bí tới mức buộc phải mở source ra đọc — dừng lại, ghi
   vào `log.md`: bạn đang cố làm gì, tài liệu nào lẽ ra phải trả lời, nó nói
   gì thay vào đó. Rồi mới được đọc. **Mỗi lần như vậy là một thất bại của sản
   phẩm, không phải của bạn.**
2. **Không đọc trước toàn bộ tài liệu.** Bắt đầu từ README như người thật:
   đọc tới đâu làm tới đó, bí thì mới đi tìm.
3. **Ghi ma sát ngay lúc nó xảy ra**, kèm timestamp thật. Không nhớ lại vào
   cuối buổi — trí nhớ luôn gột rửa bớt cơn bực.
4. **Bấm giờ.** Mỗi mốc ghi giờ bắt đầu và giờ xong.

## Tính năng phải dựng (giống hệt nhau ở cả hai nhánh)

> Người dùng dán vào một danh sách 200 URL ảnh. Hệ thống tải từng ảnh, đẩy lên
> object storage (MinIO local). Người dùng xem tiến độ theo thời gian thực, có
> thể bấm Huỷ giữa chừng. Khi kết thúc, hệ thống phải trả lời chính xác:
> **item nào đã nằm trên storage, item nào không, và vì sao.**

Ràng buộc chấp nhận (viết thành test trước khi code — xem Bước 0):

- Tiến độ không bao giờ chạy lùi, kể cả khi có hai request cập nhật song song.
- Gửi lại đúng một cập nhật tiến độ hai lần không được làm sai trạng thái.
- Bấm Huỷ khi job *vừa mới xong* phải phân biệt được với huỷ thành công.
- Mở hai tab cùng lúc, cả hai phải hội tụ về cùng một trạng thái sau reload.
- Worker bị `kill -9` giữa chừng: sau khi khởi động lại, hệ thống không được
  báo item đang dở là thành công.
- **Ảnh bị xoá khỏi storage sau khi job báo xong** — hệ thống có phát hiện
  được không? (Đây là tình huống RhinoQ tuyên bố mình sinh ra để giải quyết.
  Kiểm chứng nó, đừng tin lời quảng cáo.)

## Bước 0 — Viết trước, code sau (bắt buộc)

Trước khi cài bất cứ thứ gì, viết `spec.md` và một bộ test chấp nhận **dùng
chung cho cả hai nhánh**, không phụ thuộc thư viện nào.

Lý do: nếu viết test sau, bạn sẽ vô thức viết ra bộ test mà nhánh vừa làm xong
sẽ vượt qua.

Ghi thêm vào `spec.md`: **bạn dự đoán mỗi nhánh mất bao lâu.** Cuối buổi đối
chiếu — sai lệch giữa dự đoán và thực tế là dữ liệu, không phải điều xấu hổ.

## Bước 1 — Nhánh A: tay không

Postgres + BullMQ + Redis + bảng `tasks` bạn tự thiết kế. Không dùng RhinoQ,
không đọc tài liệu RhinoQ. Viết như bạn vẫn viết. Time-box: **4 giờ.** Hết giờ
thì dừng, ghi lại còn thiếu gì.

Đây là đối thủ thật của RhinoQ. Không phải Temporal, không phải Inngest — mà
là bảng `tasks` cộng 200 dòng trong repo của chính mình.

Chạy bộ test chấp nhận. **Ghi lại chính xác cái nào trượt.**

## Bước 2 — Nhánh B: với RhinoQ

Thư mục mới, tinh khôi. Time-box: **4 giờ.**

```bash
# LƯU Ý: bản trên npm đang cũ hơn repo và KHÁC API.
# Cài từ local, đừng npm install @rhinoq/node.
cd <ĐƯỜNG_DẪN_RHINOQ>/sdks/node && npm install && npm run build && npm pack
cd <THƯ_MỤC_LÀM_VIỆC>/arm-b && npm install <đường-dẫn-file-tgz> pg
```

Ghi việc này thành **phát hiện số 0**: một người thật `npm install @rhinoq/node`
sẽ nhận về bản cũ khác API. Họ mất bao lâu mới hiểu ra? Có bao nhiêu phần trăm
bỏ cuộc tại đây?

Sau đó theo tài liệu. Chạy đúng bộ test chấp nhận đó.

## Bước 3 — `verdict.md`

Trả lời **từng** câu, không gộp, không né:

### 3.1 Số liệu thô

Bảng hai cột A / B: số dòng code, số file, số dependency, số process phải chạy,
số datastore, số credential, số biến môi trường, **thời gian tới lần chạy đúng
đầu tiên**, số test chấp nhận vượt qua.

### 3.2 RhinoQ làm hộ được gì

Liệt kê cụ thể, gọi tên hàm/API. Với mỗi món: ở nhánh A bạn đã phải viết bao
nhiêu dòng cho đúng món đó?

### 3.3 Vẫn phải tự viết dù đã có RhinoQ

**Phần này phải dài nhất trong báo cáo.** Mọi thứ bạn tưởng nó lo hộ mà hoá ra
không: huỷ job thật sự, retry, transport realtime, phân quyền, phần UI, xử lý
lỗi, migration, wiring. Đây là thước đo trung thực duy nhất của đòn bẩy.

### 3.4 Nhánh B có tránh được bug nào của nhánh A không?

Đối chiếu kết quả test. Nếu **không có** bug nào được tránh — nói thẳng câu đó,
in đậm. Đó là kết quả quan trọng nhất có thể có.

### 3.5 Câu hỏi trung tâm

> Dự án mới tuần sau. Bạn có tự tay chọn RhinoQ không?

Có hoặc không. Không có "còn tuỳ". Nếu "có" thì kèm điều kiện phải đúng. Nếu
"không" thì nói rõ bạn chọn gì thay thế.

### 3.6 Xếp hạng trong đầu

Với bài toán này, xếp theo thứ tự bạn *thực sự* nghĩ tới: bảng tasks tự viết,
BullMQ + bull-board, Inngest, Trigger.dev, Temporal, RhinoQ. RhinoQ đứng thứ
mấy, và **cái gì đứng trước nó thì mạnh hơn ở điểm nào**.

Nếu RhinoQ không nằm trong top 3 — nói thẳng. Đó là thông tin đắt nhất trong
cả bài.

### 3.7 Phải đúng điều gì thì bạn mới đổi ý?

Liệt kê những thay đổi cụ thể, có thể kiểm chứng, sẽ đẩy RhinoQ lên hạng nhất.

## Bước 4 — Phần chê (bắt buộc, và phải dài hơn phần khen)

**10 điều tệ nhất**, xếp theo mức độ khiến bạn muốn bỏ cuộc. Mỗi điều gồm:
chuyện gì xảy ra → mất bao nhiêu phút → bạn đã kỳ vọng điều gì → tài liệu hoặc
API lẽ ra phải làm gì.

Cấm tuyệt đối các câu sau:

- "Nhìn chung khá tốt, chỉ cần…"
- "Chỉ thiếu tài liệu thôi." (Thiếu tài liệu **là** thiếu sản phẩm.)
- "Đây là prerelease nên có thể hiểu được." (Người đánh giá không quan tâm.)
- Bất kỳ câu khen nào đứng trước một câu chê để làm mềm nó.

Thêm hai mục nữa:

- **Những khoảnh khắc nghi ngờ**: mọi lần bạn nghĩ "hay thôi, tự viết cho
  nhanh". Ghi rõ lúc đó đang làm gì.
- **Những câu bạn định viết rồi tự kiểm duyệt.** Viết chúng ra. Nguyên văn.

## Bước 5 — Một câu kết

Một câu. Người bạn thân hỏi "cái RhinoQ đó dùng được không?" — bạn trả lời sao?

---

**Sản phẩm bàn giao:** `spec.md`, bộ test chấp nhận, hai thư mục `arm-a/` và
`arm-b/` chạy được, `log.md`, `verdict.md`.

**Thiên lệch phải tự khai trong `verdict.md`:** bạn làm nhánh A trước, nên khi
sang nhánh B bạn đã hiểu bài toán rồi — B được lợi thế người đi sau. Nêu rõ
điều này và ước lượng nó đáng bao nhiêu phút.

Nếu kết luận là RhinoQ không đáng dùng, hãy viết đúng như vậy. Một sản phẩm
biết mình hỏng ở đâu còn sửa được; một sản phẩm được khen sai thì không.
