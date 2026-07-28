# Runtime operations

## Worker lifecycle

Worker chạy dưới supervisor cùng các runtime runner khác. Vòng lặp claim theo slot trống: mỗi vòng claim `slot trống × prefetch`, giới hạn bởi `MaxClaimBatch`, và dispatch ngay từng job — một job chậm không chặn phần còn lại của batch.

Khi queue rỗng, worker backoff từ `PollInterval` lên `MaxPollInterval`. Nếu một queue đang bị rate limit, worker thức dậy đúng lúc cửa sổ mở lại thay vì chờ hết backoff.

### Graceful shutdown sáu bước

SIGINT/SIGTERM hủy context và khởi động trình tự dừng:

1. Ngừng claim job mới.
2. Chờ handler đang chạy kết thúc trong `ShutdownGrace`.
3. Gửi cancellation tới handler còn lại (`ctx.Done()`).
4. Chờ handler phản hồi trong `CancelGrace`.
5. Handler in-process không terminate được, nên RhinoQ không ép.
6. **Không** release lease của handler còn sống — để lease hết hạn tự nhiên.

Bước 6 là điểm dễ làm sai nhất: release lease sớm cho phép worker khác claim trong lúc handler cũ vẫn chạy, và nếu job có effect thì effect chạy hai lần. Phục hồi chậm hơn nhưng an toàn.

Job đã claim nhưng chưa kịp chạy (prefetch) được trả lại queue kèm attempt — nó chưa từng chạy nên không được tính là một lần thử.

`ShutdownReport` cho biết đã drain bao nhiêu, cancel bao nhiêu, và bao nhiêu bị bỏ lại cho lease hết hạn.

## Lease fencing

Mỗi lần claim tăng `lease_epoch`. Mọi thao tác sau đó — heartbeat, complete, fail, release, begin effect, confirm effect — phải trình đúng `(lease_owner, lease_epoch)`. Sai một trong hai thì write bị từ chối với `ErrLeaseLost`, và handler phải dừng: job đã thuộc về execution khác.

Heartbeat vừa gia hạn lease, vừa kiểm fence, vừa báo cancellation trong **một** round trip.

## Poison-job protection

Payload làm worker chết ngay khi deserialize không bao giờ ghi được một attempt thất bại bình thường, nên `maxAttempts` không chặn được. Mỗi lần reaper thu hồi lease hết hạn, `crash_count` tăng; vượt `RHINOQ_MAX_WORKER_CRASHES` thì job chuyển `blocked` với lý do `poison_job` và hiện lên Needs Attention. Replay thủ công reset lại crash budget.

`maxDistinctWorkersFailed` trong specification chưa được implement.

## Admission control

```go
err := client.SetAdmission(ctx, "video-transcode", rhinoq.AdmissionPolicy{
    MaxPending:       100_000,
    ReservedCritical: 5_000,
    OnOverflow:       rhinoq.OverflowReject,
    RetryAfter:       30 * time.Second,
})
```

Queue vượt ngân sách trả `ErrQueueOverCapacity` kèm `retryAfter`; job class `critical` được dùng phần reserved. Chế độ `delay` nhận job nhưng lùi `not_before`. Chế độ `route` và `sample` chưa được implement.

Trên PostgreSQL, mỗi enqueue vào queue có admission policy tốn thêm một count bị chặn ở đúng capacity (partial index `rhinoq_jobs_pending_by_queue_idx`), không phải count toàn bảng.

## Priority và aging

Thứ tự claim là `priority` giảm dần, FIFO trong cùng priority, cộng aging: mỗi giờ chờ tăng 1 điểm, tối đa 5. Đây là thiết kế A trong specification 28.1 — không phải weighted deficit round robin. SQL và code Go dùng cùng một công thức.

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

Các thao tác phổ biến có sẵn trực tiếp qua CLI PostgreSQL, không cần chạy
gateway:

```bash
rhinoq jobs list --queue provider-sync --states pending,blocked,dead
rhinoq queue counts provider-sync
rhinoq queue pause provider-sync
rhinoq queue resume provider-sync
rhinoq attention
rhinoq findings list
```

List output không chứa payload; thêm `--json` khi cần machine-readable output.
Các lệnh danh sách và inbox hỗ trợ `--limit` cùng `--offset` để phân trang có
giới hạn.

## Khi provider trả 202

Không coi request accepted là effect confirmed. Chọn confirmation policy phù hợp: external signal, verify hoặc predicate.

## Clock authority

DB time là authority cho `not_before`, lease expiry và rate window. Worker không tự tính mốc thời gian rồi gửi lên: retry gửi một khoảng `RetryIn`, PostgreSQL cộng vào `now()` của chính nó. Clock skew giữa worker không đẩy lệch được lịch chạy.

## Khi handler lỗi

- `transient`/`dependency_down` → retry policy.
- `rate_limited` → tôn trọng `retryAfter`.
- `permanent` → dead.
- `unknown` → blocked/needs decision.
