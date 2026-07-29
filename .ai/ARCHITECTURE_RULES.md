# Architecture invariants

1. Domain chỉ import standard library, domain sibling hoặc contracts; không
   import ports/application/runtime/adapter/interface/public facade.
2. Contracts chỉ chứa data, version và validation thuần; mapping Domain ↔
   contract nằm ở Application.
3. Application điều phối use case qua ports.
4. Adapter implement ports; adapter không chứa business invariant.
5. Runtime quản lý execution state, không tự kết luận business outcome.
6. Console/CLI/SDK gọi application facade; không gọi database/store trực tiếp.
7. Public contract phải version được và giữ backward compatibility trong thời gian migration.
8. Task state, Execution/Job state, Effect state và Outcome state là các state machine khác nhau.
9. External effect phải có idempotency key hoặc policy chuyển `uncertain`.
10. `confirm: 'on-return'` chỉ dùng khi callback return thực sự chứng minh completion.
11. `notBefore` mặc định là `0`; telemetry chỉ đưa ra đề xuất.
12. Database migration dùng expand → migrate → contract.
13. Không thêm công nghệ mới nếu chưa ghi rõ lý do, owner và cách rollback trong `DECISIONS.md`.
14. Rule SQL chạy bằng read-only role, parameterized input, statement timeout và bounded result.
15. Table-scope Rule mặc định baseline từ thời điểm enable; historical scan phải được yêu cầu rõ.
16. Task Platform là product entry point; native queue là một execution backend; Rules/Findings/timeline thuộc Verified Tasks; `scan` là no-cutover evaluation path.
17. `tests/unit/architecture_test.go` là dependency gate; layer mới phải cập
    nhật gate thay vì bypass bằng shared utility.
18. `Task.Version` là aggregate Snapshot revision; mọi create/update Execution
    phải tăng version này atomically với child write.
