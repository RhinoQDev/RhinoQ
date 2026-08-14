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

## WebSocket khi cần fan-out lớn

SSE vẫn là mặc định vì không cần cấu hình thêm. Nếu ứng dụng đã có WebSocket
server hoặc một trình duyệt cần theo dõi nhiều Task, dùng
`createTaskWebSocketHub(app.tasks)`. RhinoQ tự lo subscribe protocol có version,
gom nhiều Task trên một kết nối, đọc theo owner/tenant, gom truy vấn trùng,
fan-out snapshot, heartbeat và chặn client chậm. Ứng dụng chỉ nối socket đã xác
thực với `hub.accept()`; không bắt buộc cài Redis hay Socket.IO.

Sau khi Task đổi, gọi `hub.invalidate(taskId, identity, entityVersion)` để đẩy
ngay theo event. Hub chỉ đọc group owner/tenant liên quan, gộp các tín hiệu đến
dồn dập và dùng lại frame đã serialize; vòng quét định kỳ chỉ còn để phục hồi
khi tín hiệu bị mất.

PostgreSQL vẫn là nguồn sự thật. Redis/NATS chỉ nên là tín hiệu invalidation tùy
chọn khi fan-out rất lớn hoặc nhiều region, không mang state Task chuẩn.
