# Tài trợ RhinoQ

RhinoQ là nền tảng async Task mã nguồn mở (Apache-2.0) cho Node.js, NestJS và Go:
hàng đợi trên PostgreSQL/BullMQ, Task API, realtime UI, Effect Ledger và khôi phục
an toàn. Repo: [madebyduy/RhinoQ](https://github.com/madebyduy/RhinoQ).

Trang này mô tả **tiền tài trợ dùng vào việc gì** và **nhà tài trợ nhận lại gì**.
Nó cố ý không hứa throughput, độ trễ hay độ tin cậy nào chưa có bằng chứng kèm
theo — đó là quy tắc của dự án ([ARCHITECTURE.md §9](./ARCHITECTURE.md)) và nó áp
dụng cho cả trang gây quỹ.

> Đang ở giai đoạn beta (`0.1.0-beta.20`). Tài trợ ở đây là tài trợ cho một dự án
> đang phát triển, không phải mua hợp đồng hỗ trợ. Mục "Đối tác triển khai" bên
> dưới mới là thứ có cam kết thời gian.

---

## Tiền đi vào đâu

Theo thứ tự ưu tiên, và đây cũng là thứ tự sẽ báo cáo lại:

1. **Hạ tầng kiểm chứng.** Chạy được fault-test và benchmark có thể tái lập cần
   máy thật: PostgreSQL nhiều node, Redis, runner CI có cách ly tài nguyên. Đây là
   khoản tốn nhất và cũng là thứ quyết định RhinoQ được phép tuyên bố điều gì.
2. **Kiểm định an toàn dữ liệu đa khách hàng.** Row-level security, kiểm tra
   quyền lúc chạy, và kiểm thử rò rỉ chéo tenant.
3. **Thời gian bảo trì.** Vá lỗi, trả lời issue, giữ tương thích ngược của
   contract, và làm migration expand → migrate → contract cho từng bản phát hành.
4. **Tài liệu tiếng Việt và tiếng Anh.** Bao gồm cả tài liệu nói rõ **khi nào
   không nên dùng RhinoQ** ([docs/what-you-do-not-build.md](./docs/what-you-do-not-build.md)).

Không dùng vào: quảng cáo trả tiền, đi hội nghị, hay bất kỳ khoản nào không để lại
commit hoặc bằng chứng đo được trong repo.

---

## Các mức tài trợ

| Mức | Mức đóng góp | Nhà tài trợ nhận lại |
|---|---|---|
| **Supporter** | tuỳ tâm, một lần | Tên trong `SPONSORS.md` nếu muốn |
| **Backer** | hằng tháng, mức nhỏ | Như trên + huy hiệu trên hồ sơ GitHub |
| **Studio** | hằng tháng, mức trung bình | Logo trong `README.md`, ưu tiên phân loại (triage) issue bạn mở |
| **Infrastructure** | hằng tháng, mức lớn | Như trên + tham gia buổi review roadmap hằng quý |
| **Đối tác triển khai** | thoả thuận riêng | Xem bên dưới — đây là hạng mục duy nhất có cam kết thời gian |

Mức tiền cụ thể đặt trên trang GitHub Sponsors để giữ một nguồn sự thật duy nhất
và cho phép điều chỉnh mà không phải sửa repo.

### Điều mọi mức tài trợ **không** mua được

Nói trước cho rõ, vì đây là điểm dễ hiểu lầm nhất ở một dự án hạ tầng:

- Không mua được quyền hợp nhất (merge) một thay đổi phá vỡ ranh giới kiến trúc
  trong [ARCHITECTURE.md](./ARCHITECTURE.md).
- Không mua được cam kết SLA phản hồi, trừ hạng **Đối tác triển khai**.
- Không mua được tuyên bố hiệu năng trong README khi chưa có script và log tái lập.
- Không mua được quyền phủ quyết đối với một bản vá bảo mật.

---

## Đối tác triển khai

Dành cho tổ chức đang đưa RhinoQ vào production và cần cam kết thật:

- Một kênh liên lạc riêng và thời gian phản hồi đã thoả thuận cho sự cố chặn hệ thống.
- Rà soát kiến trúc phần tích hợp của bạn trước khi lên production.
- Ưu tiên đưa vào lịch phát hành cho tính năng mà cả hai bên đồng ý là chung cho
  nhiều người dùng — không phải tính năng riêng.
- Ghi tên trong [docs/design-partners.md](./docs/design-partners.md) nếu bạn đồng ý.

Liên hệ qua [GitHub Issues](https://github.com/madebyduy/RhinoQ/issues) với nhãn
`partnership`, hoặc qua trang GitHub Sponsors.

---

## Cách khác để đóng góp, không cần tiền

Có giá trị ngang tiền, đôi khi hơn:

- **Báo cáo một lần hỏng thật.** Log fault-test tái lập được là thứ dự án này
  cần nhất. Xem [docs/fault-matrix.md](./docs/fault-matrix.md).
- **Benchmark có phương pháp.** Đặc biệt là so với BullMQ, pg-boss,
  graphile-worker, River, Temporal hoặc Trigger.dev trên cùng một workload
  end-to-end. Xem [docs/benchmarks.md](./docs/benchmarks.md).
- **Kể lại quá trình tiếp nhận.** Chỗ nào tài liệu làm bạn mất thời gian.
- **Kiểm định bảo mật.** Xem [SECURITY.md](./SECURITY.md) để biết cách báo cáo có
  trách nhiệm.

---

## Nhà tài trợ

Chưa có nhà tài trợ nào. Phần này sẽ được cập nhật khi có, và chỉ ghi tên những
ai đồng ý được ghi tên.

<!--
Định dạng khi thêm:

### Infrastructure
- [Tên](https://ví-dụ.com) — từ 2026-09

### Studio
- [Tên](https://ví-dụ.com) — từ 2026-09
-->

---

## Minh bạch

Mỗi quý, một bản tóm tắt ngắn được thêm vào `docs/internal/` gồm: tổng thu, các
khoản chi theo bốn hạng mục ở trên, và những gì đã ra được (commit, bản phát hành,
log bằng chứng). Nếu một quý không có gì đáng kể, bản báo cáo sẽ ghi đúng như vậy.
