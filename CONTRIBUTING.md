# Contributing

Repository hiện private; contribution chỉ dành cho maintainer hoặc collaborator được cấp quyền.

## Trước khi tạo pull request

1. Đọc `AGENTS.md`, `ARCHITECTURE.md` và `.ai/DEFINITION_OF_DONE.md`.
2. Tạo task có acceptance criteria.
3. Giữ thay đổi nhỏ và đúng layer.
4. Chạy `gofmt`, `go test ./...`, `go vet ./...`.
5. Cập nhật docs/changelog nếu public behavior thay đổi.

## Quy tắc review

- Không merge khi CI fail.
- Không merge code có secret hoặc credential.
- Không bypass domain/application/ports boundary.
- Không chấp nhận benchmark claim nếu thiếu script, hardware và workload.
- Migration phải có expand → migrate → contract và rollback plan.

