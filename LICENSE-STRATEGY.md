# License strategy

Chưa gắn license public ở giai đoạn private. Không tự ý thêm license hoặc public repository khi chưa có quyết định pháp lý bằng văn bản.

Khi mở open-core, cần chọn một trong các hướng:

1. Apache-2.0 cho adoption rộng.
2. AGPLv3 cho core + commercial license cho doanh nghiệp không muốn chịu nghĩa vụ AGPL.
3. Source-available license nếu mục tiêu là hạn chế cạnh tranh SaaS, nhưng khi đó không gọi là open source.

License không ngăn việc fork. Nó chỉ quy định quyền sử dụng, phân phối, sửa đổi và nghĩa vụ tương ứng. Thương hiệu, hosted service và enterprise value phải được bảo vệ riêng.

Trước khi public:

- [ ] Chốt license bằng ADR.
- [ ] Kiểm tra dependency license.
- [ ] Tách code proprietary khỏi public packages.
- [ ] Xác nhận không có secret hoặc customer data trong git history.

