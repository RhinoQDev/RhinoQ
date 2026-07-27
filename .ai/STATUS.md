# Implementation status

Đánh giá này tính theo capability trong scope v0.1 của `RHINOQ.md`, không tính số lượng file.

| Khu vực | Trạng thái | Ghi chú |
|---|---:|---|
| COMMIT | 3/5 | schema, idempotency, correlation và payload gate đã có; transactional enqueue/outbox integration thật còn thiếu |
| RUN | 10/11 | claim, lease, heartbeat, retry+jitter, crash recovery, delayed, worker, shutdown, cancellation, DLQ và global queue rate limit đã có; fencing/admission còn thiếu |
| VERIFY | 2/3 | Effect Ledger và Outcome Level 1 nền tảng đã có; query-cost gate còn thiếu |
| RECOVER | 1/4 | derived Needs Attention, guarded replay và replay audit đã có; finding lifecycle, Resume, Repair và business search chưa có |
| DX | 0/7 | init/dev/doctor/Console/NestJS integration chưa có |
| Infrastructure | 3/10 | config, health contract, migrations/test gates và replay audit chain có; DB time, partitioning, retention, RBAC, full audit coverage/signing và benchmark còn thiếu |

## Ước lượng

- Capability code đã hiện thực: khoảng **35–40%**.
- Mức sẵn sàng release v0.1: khoảng **25–30%** vì các gate production quan trọng chưa có evidence.

Không coi đây là progress KPI tuyệt đối; mỗi mục phải được nâng lên bằng code, test và evidence tương ứng.

## Ưu tiên tiếp theo

1. PostgreSQL integration harness và transactional enqueue.
2. Lease epoch fencing.
3. Finding lifecycle, lease epoch fencing và admission control.
4. Audit append-only/hash chain.
5. Query-cost gate và benchmark harness.
