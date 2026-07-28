# Architecture invariants

1. Domain chỉ import contracts.
2. Application điều phối use case qua ports.
3. Adapter implement ports; adapter không chứa business invariant.
4. Runtime quản lý execution state, không tự kết luận business outcome.
5. Console/CLI/SDK gọi application facade; không gọi database/store trực tiếp.
6. Public contract phải version được và giữ backward compatibility trong thời gian migration.
7. Job state, effect state và outcome state là ba state machine khác nhau.
8. External effect phải có idempotency key hoặc policy chuyển `uncertain`.
9. `confirm: 'on-return'` chỉ dùng khi callback return thực sự chứng minh completion.
10. `notBefore` mặc định là `0`; telemetry chỉ đưa ra đề xuất.
11. Database migration dùng expand → migrate → contract.
12. Không thêm công nghệ mới nếu chưa ghi rõ lý do, owner và cách rollback trong `DECISIONS.md`.
13. Rule SQL chạy bằng read-only role, parameterized input, statement timeout và bounded result.
14. Table-scope Rule mặc định baseline từ thời điểm enable; historical scan phải được yêu cầu rõ.
15. Queue là core product; Rules/Findings/timeline là differentiator; `scan` là no-cutover evaluation path.
