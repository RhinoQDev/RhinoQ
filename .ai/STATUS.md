# Implementation status

Đánh giá này tính theo capability trong scope v0.1 của `RHINOQ.md`, không tính số lượng file.

| Khu vực        | Trạng thái | Ghi chú                                                                                                                                                                                                                                                              |
| -------------- | ---------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| COMMIT         |        4/5 | schema, idempotency, correlation, payload gate và transactional SQL enqueue đã được chạy trên PostgreSQL thật; business outbox integration end-to-end còn thiếu                                                                                                      |
| RUN            |      11/11 | claim, lease, heartbeat, retry+jitter, crash recovery, delayed, worker, shutdown sáu bước, cancellation, DLQ, rate limit, lease epoch fencing, poison protection và admission control đã có                                                                          |
| VERIFY         |        2/3 | Effect Ledger đầy đủ (fence begin/confirm, `effect.run()`, downgrade uncertain khi lease chết) và Outcome Level 1 nền tảng đã có; query-cost gate còn thiếu                                                                                                          |
| RECOVER        |        1/4 | derived Needs Attention, guarded replay và replay audit đã có; finding lifecycle, Resume, Repair và business search chưa có                                                                                                                                          |
| DX             |        3/7 | `rhinoq doctor` (có `--ci`), error message năm phần, Agent HTTP và TypeScript client một file đã có; `rhinoq dev`, Console, NestJS module chưa có                                                                                                                    |
| Infrastructure |       7/10 | config, health live/ready tách riêng, metrics export, migrations, PostgreSQL contract/integrity suite, replay audit chain, DB time authority và SQL enqueue có RBAC theo job name đã có; partitioning, retention, Console auth, audit signing và benchmark còn thiếu |

## Ước lượng

- Capability code đã hiện thực: khoảng **65–70%**.
- Mức sẵn sàng release v0.1: khoảng **45–50%**; storage contract đã có evidence thật nhưng fault/benchmark/retention/security gate vẫn thiếu.

Không coi đây là progress KPI tuyệt đối; mỗi mục phải được nâng lên bằng code, test và evidence tương ứng.

## Nợ kỹ thuật đã biết

- Attempt timeline đã append-only nhưng chưa có partition/retention policy và chưa mang handler/contract version.
- `maxDistinctWorkersFailed` và overflow mode `route`/`sample` chưa implement.
- Agent chưa có gRPC/Unix socket, chưa có tenant isolation, chưa có RBAC theo job name ở tầng HTTP (mới có trong SQL function).
- Race detector chưa chạy được trong môi trường hiện tại vì thiếu cgo toolchain.

## Ưu tiên tiếp theo

1. Persistent finding store/API cho acknowledge/resolve/regressed.
2. Query-cost gate và benchmark harness có workload tái lập.
3. Console queue/attempt/effect timeline đọc qua public API.
4. Outcome Level 1 hoàn chỉnh (deadline, notBefore, finality).
5. Evidence retention/partitioning và tenant/RBAC boundary.
