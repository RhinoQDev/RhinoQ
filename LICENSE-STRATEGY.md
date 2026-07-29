# License strategy

Core RhinoQ dùng **Apache-2.0**, chốt bằng ADR-0013 trong
[`.ai/DECISIONS.md`](./.ai/DECISIONS.md). Toàn văn nằm ở [`LICENSE`](./LICENSE),
attribution nằm ở [`NOTICE`](./NOTICE).

Phạm vi Apache-2.0: Go engine, domain, application, runtime, protocol, CLI,
`sdks/node`, docs và test trong repository này.

Không nằm trong phạm vi: product research chưa publish (`private/`), managed
hosted service, enterprise Console và thương hiệu RhinoQ.

## Vì sao Apache-2.0

Adoption rộng nhất cho một job queue, kèm patent grant rõ ràng — điều MIT không
có và là rủi ro không cần thiết với hạ tầng dữ liệu. AGPLv3 bị loại vì nhiều
công ty cấm AGPL trong policy, chặn đúng nhóm design partner đang cần. BSL và
source-available bị loại vì khi đó không được gọi là open source.

License không ngăn việc fork, và Apache-2.0 cũng không ngăn bên khác chạy hosted
service trên core. Nó chỉ quy định quyền sử dụng, phân phối, sửa đổi và nghĩa vụ
tương ứng. Thương hiệu, hosted service và enterprise value phải được bảo vệ
riêng.

## Nghĩa vụ đang mở

- [x] Chốt license bằng ADR.
- [x] Đặt `LICENSE` và `NOTICE` ở repository root.
- [x] Đưa `LICENSE` vào npm package (`sdks/node`).
- [ ] Audit license của toàn bộ dependency và lưu bằng chứng. Hiện tại chỉ có
      `jackc/pgx` (MIT) và `golang.org/x` (BSD-3-Clause); Node SDK không có
      runtime dependency.
- [x] Quét secret bằng Gitleaks 8.30.1 trên 42 commit và working tree
      (2026-07-29): không tìm thấy leak. Đây là snapshot, không thay thế
      continuous scan; xem `docs/security-audit-2026-07-29.md`.
- [ ] Chốt nơi giữ code proprietary khi bắt đầu open-core.

## Ràng buộc cho thay đổi sau này

Mọi dependency mới phải tương thích Apache-2.0. Không đưa GPL hoặc AGPL vào
core. License đã public cho một commit thì không thu hồi được; chỉ có thể đổi
license cho release về sau, và cần đồng thuận của mọi contributor giữ copyright.
