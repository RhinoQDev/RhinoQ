# Runtime operations

## Worker lifecycle

Worker chạy dưới supervisor cùng các runtime runner khác. SIGINT/SIGTERM hủy context; handler nhận cancellation cooperative; lease reaper xử lý job bị bỏ lại.

## Queue rate limit

Rate limit là giới hạn toàn cục theo tên queue, áp dụng chung cho mọi worker:

```go
err := client.SetRateLimit(ctx, "provider-sync", 100, time.Minute)
ttl, err := client.RateLimitTTL(ctx, "provider-sync")
err = client.RemoveRateLimit(ctx, "provider-sync")
```

Job vượt giới hạn vẫn ở `pending`/`retry_wait`; chúng không bị tính là failure và không tăng attempt. PostgreSQL khóa rate window trong cùng transaction claim để nhiều worker không dùng vượt allowance. Phiên bản hiện tại dùng fixed window; group/tenant limit và sliding window chưa thuộc v0.1.

## Queue inspection

Backend cho Console không truy vấn bảng nội bộ trực tiếp. Dùng API ổn định để lấy count và danh sách có phân trang:

```go
counts, err := client.JobCounts(ctx, "provider-sync")
jobs, err := client.ListJobs(ctx, rhinoq.JobQuery{
    Queue:  "provider-sync",
    States: []string{"pending", "blocked", "dead"},
    Offset: 0,
    Limit:  100,
})
```

`Limit` bắt buộc nằm trong `1..1000`. Kết quả mặc định mới nhất trước; payload không nằm trong `JobSummary` để API danh sách không vô tình trở thành đường xuất dữ liệu nhạy cảm.

## Khi provider trả 202

Không coi request accepted là effect confirmed. Chọn confirmation policy phù hợp: external signal, verify hoặc predicate.

## Khi handler lỗi

- `transient`/`dependency_down` → retry policy.
- `rate_limited` → tôn trọng `retryAfter`.
- `permanent` → dead.
- `unknown` → blocked/needs decision.
