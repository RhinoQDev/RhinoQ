# Tài liệu RhinoQ bằng tiếng Việt

[English documentation](../README.md)

Nếu mới dùng RhinoQ, hãy đọc theo thứ tự này:

1. [Bắt đầu trong 5 phút](./bat-dau.md)
2. [Khai báo một Task](./khai-bao-task.md)
3. [File, video lớn, nhiều file và ZIP](./tep-va-artifact.md)
4. [API, SSE, WebSocket tùy chọn và giao diện](./api-va-giao-dien.md)
5. [Checklist trước khi chạy production](./production-checklist.md)
6. [Ma trận bao phủ hệ sinh thái async (English)](../async-capability-coverage.md)
7. [Kế hoạch nâng cấp RhinoQ](../ke-hoach-nang-cap-rhinoq.md)
8. [Kế hoạch First Value / README / DX](./ke-hoach-tong-the-first-value-readme-dx.md)

Dành cho người đóng góp và người vận hành:

- [Luồng và quan hệ giữa các tầng xử lý](./luong-va-quan-he-cac-tang.md) — bản đồ
  kiến trúc đầy đủ hai mặt phẳng, mô hình dữ liệu và bản đồ khoá.
- [Kế hoạch nâng cấp hiệu năng và bảo mật](./nang-cap-hieu-nang-va-bao-mat.md) —
  các điểm ngắt mạch đã xác định, cách sửa và bộ đo thay thế.
- [Backlog cải tiến tích hợp và hiệu năng](./backlog-tich-hop-va-hieu-nang.md) —
  7 finding ma sát DX (đã kiểm chứng) + mục tiêu hiệu năng còn lại, xếp ưu tiên.

## RhinoQ giải quyết việc gì?

Bạn viết hàm nghiệp vụ. RhinoQ cung cấp phần hạ tầng lặp lại xung quanh tác vụ
bất đồng bộ: queue PostgreSQL hoặc kết nối BullMQ, trạng thái bền vững,
progress, retry có giới hạn, cancel, API, SSE với polling fallback, Task Center,
Workbench, health/readiness/metrics, artifact và bằng chứng để đối soát.

RhinoQ không tự đoán authentication, tenant, credential cloud, retry nghiệp vụ
hay định nghĩa “kết quả đúng”. Những phần này vẫn thuộc ứng dụng của bạn.
