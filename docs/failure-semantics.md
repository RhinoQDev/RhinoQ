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

