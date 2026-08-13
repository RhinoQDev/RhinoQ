# API, SSE và giao diện có sẵn

`app.http()` mount chung owner API, Task Center và Workbench. Ứng dụng cung cấp
owner/tenant từ session đã xác thực; RhinoQ không lấy owner từ query string.

Người dùng nhận được:

- danh sách và chi tiết Task;
- progress trực tiếp bằng SSE;
- polling fallback khi SSE mất;
- cancel/retry chỉ khi backend khai báo capability;
- lịch sử attempt;
- waitpoint/approval;
- artifact, checksum, expiry và signed download;
- trạng thái loading/error/empty và hỗ trợ accessibility cơ bản.

Task Center mặc định ở `/task-center`, API ở `/tasks`, Workbench ở `/admin`.
Operator token chỉ đổi thành cookie HttpOnly/SameSite, không nhúng trong HTML.

SSE là kênh cập nhật, không phải nguồn dữ liệu thứ hai. PostgreSQL vẫn là nguồn
trạng thái authoritative; snapshot có version giúp client bỏ dữ liệu cũ.

Production phải đặt TLS, authentication, authorization, rate limit và network
policy phía trước các route này. Đọc [checklist production](./production-checklist.md).
