# Contributing

RhinoQ nhận contribution qua pull request. Dự án đang ở active development nên
public API, migration và protocol còn thay đổi; hãy mở issue để thống nhất
hướng trước khi làm thay đổi lớn.

Contribution được nhận theo [Apache-2.0](./LICENSE), đúng như mục 5 của license
quy định. Không cần ký CLA riêng.

## Trước khi tạo pull request

1. Đọc `AGENTS.md`, `ARCHITECTURE.md` và `.ai/DEFINITION_OF_DONE.md`.
2. Tạo task có acceptance criteria.
3. Giữ thay đổi nhỏ và đúng layer.
4. Chạy `gofmt`, `go test ./...`, `go vet ./...`.
5. Chạy `npm --prefix sdks/node test` nếu chạm Node SDK.
6. Cập nhật docs/changelog nếu public behavior thay đổi.

## Quy tắc review

- Không merge khi CI fail.
- Không merge code có secret hoặc credential.
- Không bypass domain/application/ports boundary.
- Không chấp nhận benchmark claim nếu thiếu script, hardware và workload.
- Migration phải có expand → migrate → contract và rollback plan.
- Dependency mới phải tương thích Apache-2.0; không nhận GPL hoặc AGPL.

## Báo lỗ hổng bảo mật

Không mở issue công khai. Xem [`SECURITY.md`](./SECURITY.md).
