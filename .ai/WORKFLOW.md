# AI development workflow

## 1. Inspect

Đọc `AGENTS.md`, task, architecture rules và các file liên quan. Tìm symbol bằng `rg`; không sửa theo suy đoán.

## 2. Plan

Ghi rõ:

- mục tiêu và ngoài phạm vi
- file sẽ đổi
- invariant bị ảnh hưởng
- test cần thêm
- migration/rollback nếu có

## 3. Implement

Ưu tiên thay đổi nhỏ, giữ public API tương thích. Mỗi effect/outcome mới phải có failure semantics.

## 4. Verify

Chạy test phù hợp theo tầng. Nếu không chạy được, ghi nguyên nhân chính xác; không nói “đã pass”.

## 5. Review

Rà diff, import boundary, secret/payload, retry mù, race condition, migration
và docs. Với mọi thay đổi user-visible, đối chiếu `README.md`: capability,
command, limitation và trạng thái phải khớp code hiện tại.

## 6. Handoff

Báo file đã đổi, hành vi mới, lệnh kiểm tra, kết quả, giới hạn và việc tiếp theo.
Cập nhật `README.md` và `CHANGELOG.md` nếu thay đổi user-visible; nếu README
không cần đổi, ghi rõ lý do trong handoff.
