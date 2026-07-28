# Governance

## Giai đoạn hiện tại

RhinoQ là dự án open source theo [Apache-2.0](./LICENSE), do một maintainer dẫn
dắt (benevolent dictator). Maintainer giữ quyền quyết định release, public API,
schema và license.

Đây chưa phải mô hình governance có nhiều bên; nó sẽ được mở rộng khi có
contributor thường xuyên ngoài maintainer.

## Ranh giới open-core

Đang mở theo Apache-2.0: Go engine/domain/application/runtime, protocol, CLI,
Node.js SDK, docs và test nền tảng.

Có thể giữ thương mại: managed hosted service, enterprise Console/workflow,
support/SLA và operational automation riêng.

Apache-2.0 không ngăn bên khác chạy hosted service trên core. Giá trị thương mại
nằm ở vận hành, thương hiệu và cam kết hỗ trợ, không nằm ở license — xem
ADR-0013 trong [`.ai/DECISIONS.md`](./.ai/DECISIONS.md).

## Quyền merge

- Mọi thay đổi cần PR.
- Ít nhất một maintainer review.
- Domain, protocol, migration hoặc security cần hai người review khi team đủ lớn.
- Release chỉ được tạo từ commit đã pass CI.
