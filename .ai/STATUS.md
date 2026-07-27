# Implementation status

Đánh giá này tính theo capability trong scope v0.1 của `RHINOQ.md`, không tính số lượng file.

| Khu vực | Trạng thái | Ghi chú |
|---|---:|---|
| COMMIT | 3/5 | schema, idempotency, correlation và payload gate đã có; transactional enqueue/outbox integration thật còn thiếu |
| RUN | 11/11 | claim, lease, heartbeat, retry+jitter, crash recovery, delayed, worker, shutdown sáu bước, cancellation, DLQ, rate limit, lease epoch fencing, poison protection và admission control đã có |
| VERIFY | 2/3 | Effect Ledger đầy đủ (fence begin/confirm, `effect.run()`, downgrade uncertain khi lease chết) và Outcome Level 1 nền tảng đã có; query-cost gate còn thiếu |
| RECOVER | 1/4 | derived Needs Attention, guarded replay và replay audit đã có; finding lifecycle, Resume, Repair và business search chưa có |
| DX | 3/7 | `rhinoq doctor` (có `--ci`), error message năm phần, Agent HTTP và TypeScript client một file đã có; `rhinoq dev`, Console, NestJS module chưa có |
| Infrastructure | 6/10 | config, health live/ready tách riêng, metrics export, migrations/test gates, replay audit chain, DB time authority và SQL enqueue có RBAC theo job name đã có; partitioning, retention, Console auth, audit signing và benchmark còn thiếu |

## Ước lượng

- Capability code đã hiện thực: khoảng **60–65%**.
- Mức sẵn sàng release v0.1: khoảng **35–40%** vì các gate production quan trọng vẫn chưa có evidence.

Không coi đây là progress KPI tuyệt đối; mỗi mục phải được nâng lên bằng code, test và evidence tương ứng.

## Nợ kỹ thuật đã biết

- PostgreSQL adapter chưa có test chạy trên database thật; toàn bộ SQL mới (fencing, admission, bulk claim, poison protection) mới chỉ được review, chưa được thực thi.
- `maxDistinctWorkersFailed` và overflow mode `route`/`sample` chưa implement.
- Agent chưa có gRPC/Unix socket, chưa có tenant isolation, chưa có RBAC theo job name ở tầng HTTP (mới có trong SQL function).
- `rhinoq.enqueue()` và migration 003 chưa chạy trên PostgreSQL thật.
- Race detector chưa chạy được trong môi trường hiện tại vì thiếu cgo toolchain.

## Ưu tiên tiếp theo

1. PostgreSQL integration harness — chạy toàn bộ SQL mới trên database thật.
2. Finding lifecycle (acknowledge/resolve/regressed).
3. Console queue view.
4. Query-cost gate và benchmark harness.
5. Outcome Level 1 hoàn chỉnh (deadline, notBefore, finality).
