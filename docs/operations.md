# Runtime operations

## Worker lifecycle

Worker chạy dưới supervisor cùng các runtime runner khác. SIGINT/SIGTERM hủy context; handler nhận cancellation cooperative; lease reaper xử lý job bị bỏ lại.

## Khi provider trả 202

Không coi request accepted là effect confirmed. Chọn confirmation policy phù hợp: external signal, verify hoặc predicate.

## Khi handler lỗi

- `transient`/`dependency_down` → retry policy.
- `rate_limited` → tôn trọng `retryAfter`.
- `permanent` → dead.
- `unknown` → blocked/needs decision.

