# Definition of Done

- [ ] Task có acceptance criteria rõ.
- [ ] Code nằm đúng layer.
- [ ] Không có import vòng hoặc bypass port.
- [ ] Happy path và failure path đều được xử lý.
- [ ] Effect có idempotency/confirmation policy.
- [ ] Outcome phân biệt `achieved`, `mismatch`, `unverifiable`, `stale`.
- [ ] Có unit/contract/integration/fault test phù hợp.
- [ ] Không có benchmark claim chưa có evidence.
- [ ] Docs và examples khớp code.
- [ ] Mọi thay đổi user-visible đã cập nhật `README.md`, hoặc ghi rõ lý do
      README không bị ảnh hưởng.
- [ ] Migration có rollback hoặc kế hoạch phục hồi.
- [ ] `go test ./...` và `npm --prefix sdks/node test` đã chạy, hoặc đã ghi rõ blocker.
- [ ] Diff không chứa secret, debug code hoặc file ngoài phạm vi.
- [ ] Changelog được cập nhật nếu public behavior thay đổi.
