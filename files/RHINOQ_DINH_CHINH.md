# RhinoQ — Đính chính khung sản phẩm và danh sách sửa

> Sửa lỗi định vị chung của `RHINOQ_V2_CHIEN_LUOC.md` và `RHINOQ_NANG_CAP_DX.md`.
> Đọc file này **trước** hai file kia. Mục 6–8 là danh sách sửa cụ thể, có thể áp thẳng.
>
> **Đính chính kỹ thuật 2026-07-28:** pg-boss hiện có dashboard package,
> dependency workflows, rate limiting, priority và DLQ. Lợi thế của RhinoQ là
> cách đóng gói business invariant + Finding + outside-in recovery, không phải
> độc quyền SQL hay giả định đối thủ “không có console”.

---

## 1. Lỗi gốc

Hai file trước để trọng tâm trôi từ **bốn lớp** xuống **một lớp**.

Chuyện đã xảy ra: tôi cần một dấu hiệu nhu cầu **nhìn thấy được** để kiểm chứng. "Cho tôi xem đoạn cron reconciliation" thoả mãn điều đó — bằng chứng vật lý, cầm nắm được. Nhưng rồi tôi để cái tiện lợi trong việc kiểm chứng định nghĩa luôn sản phẩm.

Kết quả: cron nằm ở một phần tư của lớp RECOVER, và nó chiếm mất chỗ của cả COMMIT, RUN, VERIFY trong toàn bộ lập luận.

Hai hệ quả sai lệch:

- **Sai về sản phẩm** — mục 13 file chiến lược viết như thể ba lớp kia là hạ tầng phụ trợ
- **Sai về kiểm chứng** — "4/5 dev không có cron → dừng dự án" dùng sai tín hiệu. Nhiều team đã đau vẫn không có cron; họ sửa tay mỗi lần. **Vắng cron không có nghĩa vắng nhu cầu.**

---

## 2. Khung đúng

> **Bốn lớp COMMIT · RUN · VERIFY · RECOVER là sản phẩm.**
> **RECOVER là cửa vào, vì nó demo được trong 30 giây.**

Không phải: *RECOVER là sản phẩm, ba lớp kia là hạ tầng.*

Phân biệt này quan trọng vì nó tách hai câu hỏi khác nhau:

| Câu hỏi | Trả lời |
| --- | --- |
| Bán bằng gì? | RECOVER — `47 order đã thanh toán, chưa từng có job provision` |
| Người ta ở lại vì gì? | **cả bốn lớp** — một cái queue mà mất job thì rule có hay đến đâu cũng vô nghĩa |

Marketing một lớp, sản phẩm bốn lớp. Bản gốc `RHINOQ.md` mục 3 đã đúng ngay từ đầu; tôi làm nó lệch đi.

---

## 3. Bốn lớp — giá trị và bằng chứng nhu cầu

Mỗi lớp có bài toán riêng, người dùng cảm nhận ở thời điểm khác nhau, và **có dấu hiệu nhu cầu nhìn thấy được riêng**. Bảng này thay thế mọi chỗ trong hai file trước chỉ nói về rule/finding.

| Lớp | Bài toán | Người dùng thấy giá trị khi nào | Dấu hiệu nhu cầu nhìn thấy được |
| --- | --- | --- | --- |
| **COMMIT** | dual-write: business record commit rồi, job bay mất | ngày 1, âm thầm | có outbox table · bug "job không chạy sau deploy" · dùng BullMQ mà lại chạy Postgres |
| **RUN** | thực thi đúng, crash recovery, không mất việc, không chạy hai lần | ngày 1, âm thầm | **ai cũng có** — đang dùng BullMQ/pg-boss là đủ |
| **VERIFY** | job xong nhưng state sai · effect treo `uncertain` | tuần 2–4 | **đoạn code phòng thủ trong handler** · cột `retry_safe` · comment `// TODO: idempotency` |
| **RECOVER** | tra ngược từ business record · sửa an toàn · thấy việc chưa vào queue | **ngay lần chạy đầu** | script backfill vứt đi · trang admin nội bộ tra order · cron |

### 3.1 Ba nhận xét

**COMMIT và RUN là giá trị âm thầm.** Người dùng không bao giờ "cảm thấy hay" vì chúng — họ chỉ rời đi nếu chúng thiếu. Đây là lý do bar pg-boss vẫn đúng, và là lý do không được cắt thêm gì ở hai lớp này.

**VERIFY có dấu hiệu nhu cầu tốt nhất mà tôi đã bỏ qua:** đoạn code phòng thủ trong handler. Nó **luôn tồn tại** trong hệ thống đã chạy production, nằm ngay trong code, và thường được viết **sau một sự cố**. Hỏi ra đoạn đó là hỏi ra được cả câu chuyện đau. Tốt hơn hẳn câu hỏi về cron.

**RECOVER cho giá trị nhanh nhất, nên nó là cửa vào.** Nhưng nó cũng là lớp mà người dùng có thể sống thiếu lâu nhất — nếu ba lớp kia yếu, họ không bao giờ đi tới đây.

### 3.2 Đính chính về VERIFY

File chiến lược mục 6 kết luận "Effect Ledger không phải điểm bán". **Kết luận đó vẫn đúng** — Stripe, Adyen, Square đều có idempotency key, nên retry mù không nguy hiểm nếu dev nhớ truyền key.

Nhưng nó bị viết như thể **giết cả lớp VERIFY**. Sai. VERIFY gồm hai thứ:

| | Trạng thái |
| --- | --- |
| **Effect Ledger** | hạ cấp thành guardrail chống quên. Đúng như mục 6 đã viết |
| **Outcome** (nay là Rule scope `job`) | **vẫn là lõi.** "Job xong nhưng credit lệch 3" không có provider nào giải hộ |

Đọc mục 6 file chiến lược kèm đính chính này.

---

## 4. Kiểm chứng nhu cầu — bốn câu, mỗi lớp một câu

Thay thế mục 8.1 file chiến lược. Hỏi 5 dev đang chạy Postgres + background job.

**1 — COMMIT**
> Có bao giờ business record tồn tại mà job không bao giờ chạy không? Xảy ra lúc nào — deploy, OOM, pod bị evict?

**2 — RUN**
> Mỗi lần deploy có để lại job orphaned không? Bạn xử lý thế nào? Có bao giờ một job chạy hai lần không?

**3 — VERIFY** ← **câu quan trọng nhất**
> Trong handler của bạn có đoạn nào phòng thủ kiểu "kiểm tra xem việc này làm rồi chưa" không? **Cho tôi xem đoạn đó.** Ai bảo bạn viết nó — hay là sau một sự cố?

**4 — RECOVER**
> Lần cuối phải sửa vài trăm record sai, bạn làm gì? Còn giữ script không? Bạn đang dùng gì để xem job đang chạy?

### 4.1 Vì sao câu 3 thay câu về cron

| | Cron reconciliation | Code phòng thủ trong handler |
| --- | --- | --- |
| Tỷ lệ tồn tại ở team đã đau | trung bình — nhiều team sửa tay | **rất cao** |
| Dễ tìm không? | phải nhớ ra | nằm ngay trong code đang mở |
| Kể được câu chuyện? | ít | **có** — luôn viết sau một sự cố |

Vắng cron không suy ra vắng nhu cầu. Vắng code phòng thủ thì suy ra được nhiều hơn.

---

## 5. Tiêu chí dừng — sửa lại

Thay thế mục 10.2 file chiến lược. Bốn tín hiệu, không phải một.

| Tín hiệu | Ngưỡng dừng |
| --- | --- |
| Không ai kể được **một sự cố cụ thể** thuộc bất kỳ lớp nào trong bốn lớp | ≥ 4/5 → **dừng, nghĩ lại** |
| Không ai có code phòng thủ trong handler | ≥ 4/5 → định vị VERIFY sai |
| 3 tháng sau publish, < 3 user thật (production, không phải star) | dừng |
| 6 tháng, không ai mở issue xin tính năng | dừng |
| < 20% user tạo ít nhất 1 rule | differentiator không hấp dẫn — còn lại chỉ là queue thường |

**Bỏ hẳn tiêu chí cũ:** *"4/5 dev không có cron reconciliation → nhu cầu không tồn tại"*. Tín hiệu sai.

Điều kiện đi tiếp: **≥ 3/5 kể được một sự cố cụ thể ở bất kỳ lớp nào.** Không cần cùng một lớp — bốn lớp là bốn cửa vào khác nhau.

---

## 6. Sửa cụ thể — `RHINOQ_V2_CHIEN_LUOC.md`

### 6.1 Mục 1 — Quyết định

**Bỏ** bảng "queue = cái vỏ / integrity = lý do quay lại". Nó hạ cấp COMMIT và RUN thành bao bì.

**Thay bằng:**

> RhinoQ là job queue bốn lớp: COMMIT · RUN · VERIFY · RECOVER.
>
> - COMMIT và RUN là **giá trị âm thầm** — không ai khen, nhưng thiếu là mất người. Bar: ngang pg-boss
> - VERIFY và RECOVER là **giá trị nhìn thấy được** — RhinoQ phải đóng gói chúng tốt hơn cron/SQL/admin rời rạc
> - **RECOVER là cửa vào** vì nó demo được trong 30 giây
>
> Sai lầm về thứ tự trong `RHINOQ.md` bản gốc vẫn phải sửa: differentiator lên sóng tuần 8, không phải tháng 12. Nhưng "lên sóng sớm" không có nghĩa "ba lớp kia là phụ".

### 6.2 Mục 3 — đổi tiêu đề

`Ba tính năng tạo khác biệt` → **`Ba tính năng cửa vào (lớp RECOVER)`**

Thêm câu mở đầu:

> Ba tính năng dưới đây thuộc lớp RECOVER. Chúng được ưu tiên **không phải vì quan trọng hơn ba lớp kia**, mà vì chúng cho giá trị nhìn thấy được nhanh nhất — nên chúng là cửa vào.

### 6.3 Mục 6 — thêm đính chính

Chèn vào cuối mục 6:

> **Phạm vi của kết luận này:** Effect Ledger bị hạ cấp, **không phải cả lớp VERIFY**. Outcome (Rule scope `job`) vẫn là lõi — "job xong nhưng credit lệch 3" không provider nào giải hộ. Xem mục 3.2 file đính chính.

### 6.4 Mục 8.1 — thay toàn bộ

Thay bằng bốn câu ở mục 4 file này.

### 6.5 Mục 10.1 — thêm dòng

| Giai đoạn | Chỉ số | Ngưỡng |
| --- | --- | --- |
| Sau validation | dev kể được sự cố cụ thể ở **bất kỳ lớp nào** | ≥ 3/5 |
| Sau validation | dev có code phòng thủ trong handler | ≥ 3/5 |

**Xoá** dòng cũ: *"dev có cron reconciliation · ≥ 2/5"*.

### 6.6 Mục 10.2 — thay bằng mục 5 file này

### 6.7 Mục 13 — Phán quyết

**Thay đoạn kết:**

> Job queue biết những gì đã đi vào nó.
> RhinoQ biết những gì lẽ ra phải đi vào nó, và những gì đi ra không đúng.
>
> Nó nói được điều đó vì bốn lớp cùng tồn tại: **COMMIT** đảm bảo intent không mất, **RUN** đảm bảo thực thi đúng, **VERIFY** đảm bảo kết quả nghiệp vụ chính xác, **RECOVER** đảm bảo sai lệch có đường sửa. Bỏ bất kỳ lớp nào thì ba lớp còn lại mất nghĩa.
>
> Chạy gần business data giúp VERIFY và RECOVER rẻ và nhất quán hơn. Đây là lợi
> thế mặc định và packaging cần kiểm chứng, không phải moat kỹ thuật không thể
> sao chép; pg-boss hoặc application code trong cùng Postgres có nền tảng tương
> tự.

---

## 7. Sửa cụ thể — `RHINOQ_NANG_CAP_DX.md`

### 7.1 Mục 1 — bổ sung chỉ số cho COMMIT/RUN

Ba chỉ số hiện tại chỉ đo lớp RECOVER. Thêm hai:

| Chỉ số | Mục tiêu | Lớp |
| --- | --- | --- |
| Thời gian tới job đầu tiên chạy được | **< 10 phút** từ cài CLI/Go module | COMMIT + RUN |
| Deploy không để lại job orphaned | 100%, không cần cấu hình gì | RUN |

Chỉ số thứ hai đáng nói riêng: **graceful shutdown phải đúng theo mặc định**, không phải một tuỳ chọn người dùng phải bật. Đây là DX quan trọng nhất của lớp RUN, và nó vô hình — người dùng chỉ nhận ra khi nó thiếu.

### 7.2 Mục 1.1 — giới hạn phạm vi của "vạch hoà vốn rule thứ hai"

Thêm câu:

> Tính toán này **chỉ áp cho lớp RECOVER**. COMMIT và RUN cho giá trị ngay ngày
> đầu. Không dùng “console” làm khác biệt với pg-boss vì pg-boss hiện có
> `@pg-boss/dashboard`; khác biệt phải nằm ở business correlation, Rule và
> Finding lifecycle.

### 7.3 Mục 3 — thêm đường vào thứ hai

Mục 3 hiện tại chỉ có một đường: `scan` → `init --from-scan`. Đó là đường của người vào bằng RECOVER.

Thêm mục **3.5 — Đường vào bằng queue**:

```
$ npm i rhinoq && npx rhinoq init --apply
$ rhinoq dev
  ✓ worker · console · 0 rule

  Chưa có rule nào. Chạy `rhinoq suggest` để xem RhinoQ tìm được gì
  trong database của bạn.
```

Người vào bằng queue **không bị ép** viết rule. Họ có thể bắt đầu bằng
COMMIT/RUN và tự khám phá VERIFY/RECOVER khi sẵn sàng. `rhinoq suggest` là giả
thuyết roadmap, chưa phải chức năng hiện có.

Đây là điểm quan trọng: **ép viết rule ngay lúc cài là mất nhóm người dùng vào bằng queue** — mà nhóm đó có thể đông hơn.

### 7.4 Mục 11 — sửa hai câu README

Câu thứ nhất hiện tại nói *"nếu chỉ có một thứ cần kiểm tra, đừng cài RhinoQ"*. Đúng cho RECOVER, sai cho toàn sản phẩm — nó đuổi người vào bằng queue đi.

**Sửa thành:**

> **Chỉ cần một job queue trên Postgres?** RhinoQ dùng được ngay như vậy — transactional enqueue, crash recovery, và một console. Lớp verify/recover là tuỳ chọn, bật khi bạn cần.

> **Chỉ có đúng một thứ cần kiểm tra?** Một cron 30 dòng đúng hơn. Lớp rule của RhinoQ bắt đầu có lãi từ rule thứ hai, thứ ba.

Giữ nguyên câu về "RhinoQ không tự biết business logic của bạn".

---

## 8. `RHINOQ_NANG_CAP.md` — nghỉ hưu chính thức

File đó đề xuất **bỏ hẳn queue layer**, làm library đứng cạnh BullMQ. Sai vì mất category, mất đường phân phối, và làm cái tên vô nghĩa. Đã bị thay bởi file chiến lược mục 2.3.

Giữ lại vì hai phần vẫn đúng và đã được chuyển sang file chiến lược: bài kiểm tra nhu cầu bốn mức A/B/C/D, và phân tích idempotency key của Stripe. **Không dùng file đó làm tài liệu tham chiếu nữa.**

---

## 9. Cái gì KHÔNG đổi

Phần lớn công việc đứng vững. Liệt kê rõ để không phải đọc lại từ đầu:

| | Trạng thái |
| --- | --- |
| Toàn bộ `RHINOQ.md` mục 8–50 (schema, lease, fencing, graceful shutdown, retry classification, cancellation, poison job, runtime semantics) | **giữ nguyên** |
| Bar là pg-boss, không phải BullMQ | **đúng** |
| Differentiator lên sóng tuần 8 | **đúng** |
| Lợi thế cấu trúc: nằm trong cùng DB với business data | **đúng** — và là thứ cho phép cả VERIFY lẫn RECOVER |
| Gộp Outcome + Reconciliation thành Rule | **đúng** |
| Rule API ba tầng, mặc định config | **đúng** |
| Timeline theo correlation là tính năng giữ chân số một | **đúng** |
| `scan` chạy được mà không cần cài | **đúng** |
| Một webhook + OTel + GitHub Action, không N integration | **đúng** |
| Scope 17–19 tuần, ba giai đoạn | **đúng** |
| Danh sách cắt (mục 5 file chiến lược) | **đúng** — không lớp nào bị cắt oan |

Chỉ có khung diễn giải sai, không phải nội dung sai.

---

## 10. Một câu để nhớ

> Bốn lớp là sản phẩm. RECOVER là cửa vào.
> Đừng để cái dễ demo nhất trở thành cái duy nhất bạn nghĩ mình đang làm.
