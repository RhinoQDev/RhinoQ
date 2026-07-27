# Governance

## Giai đoạn hiện tại

RhinoQ đang ở giai đoạn private core development. Maintainer giữ quyền quyết định release, public API, schema và license.

## Khi chuẩn bị open-core

Phần dự kiến mở: Go engine/domain/application/runtime cần thiết, protocol, TypeScript SDK, docs và test nền tảng.

Phần có thể giữ thương mại: managed hosted service, enterprise Console/workflow, support/SLA và operational automation riêng.

Danh sách này phải được chốt bằng ADR trước khi public repository.

## Quyền merge

- Mọi thay đổi cần PR.
- Ít nhất một maintainer review.
- Domain, protocol, migration hoặc security cần hai người review khi team đủ lớn.
- Release chỉ được tạo từ commit đã pass CI.

