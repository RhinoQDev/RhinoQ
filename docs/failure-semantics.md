# Failure semantics

| Tình huống | Kết quả bắt buộc |
|---|---|
| Worker chết trước claim | job vẫn pending |
| Worker chết sau claim | lease reaper requeue sau expiry |
| Handler throw permanent | dead, không retry |
| Handler throw unknown | blocked, không retry mù |
| Provider trả 202 | request accepted, chưa confirmed |
| Process chết sau external request | effect uncertain |
| Outcome đọc replica cũ | stale, không mismatch |
| Lease hết hạn | worker cũ không được complete |
| Worker cũ quay lại sau khi mất lease | mọi write bị từ chối vì epoch đã tăng |
| Worker cũ mở effect sau khi mất lease | bị chặn ngay tại `BeginEffect`, không có row nào được tạo |
| Job làm worker chết nhiều lần | park sang `blocked`/`poison_job`, không giao cho worker tiếp theo |
| Handler không phản hồi cancel khi shutdown | lease được để hết hạn tự nhiên, không release sớm |
| Job prefetch nhưng chưa chạy khi shutdown | trả lại queue kèm attempt |
| Queue vượt ngân sách admission | enqueue bị từ chối với `RHINOQ_QUEUE_OVER_CAPACITY` kèm `retryAfter`; job critical vẫn dùng được phần reserved |

