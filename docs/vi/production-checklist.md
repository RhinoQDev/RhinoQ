# Checklist trước khi chạy production

RhinoQ hiện là prerelease. Checklist này giúp bạn đánh giá deployment cụ thể,
không tạo SLA chung cho dự án.

## Bắt buộc

1. Pin chính xác version; không dùng `latest` hoặc `next` trong production.
2. Dùng PostgreSQL role tối thiểu, không superuser/BYPASSRLS.
3. Backup, chạy migration rehearsal và restore drill.
4. Bảo vệ `/tasks`, `/task-center`, `/admin`, health và metrics bằng TLS,
   authentication, authorization, network policy và rate limit.
5. Test duplicate/out-of-order event, worker chết, PostgreSQL/Redis restart và
   multi-replica takeover trên topology giống production.
6. Khai báo idempotency/confirmation cho external effect; unknown phải
   `uncertain`, không retry mù.
7. Với artifact: bucket private, signed URL ngắn hạn, giới hạn MIME/dung lượng,
   lifecycle/retention, multipart abort cleanup và provider readback.
8. Theo dõi queue depth, oldest due lag, failure, retry, uncertain outcome,
   connection pool và dung lượng storage.
9. Chạy `rhinoq doctor`, compatibility gate và smoke test bằng đúng role/env sẽ
   deploy.
10. Có runbook, người chịu trách nhiệm và rollback/forward-fix rõ ràng.

## Chưa nên dùng

- public/hostile multi-tenant nếu chưa đóng đầy đủ authorization boundary;
- workload yêu cầu upstream production SLA;
- external effect không có stable identity và readback;
- file lớn đi qua queue payload hoặc application proxy không có streaming.

Chi tiết và pass condition đầy đủ: [Production checklist tiếng Anh](../production-checklist.md)
và [production readiness](../production-readiness.md).
