# Release checklist

## Contract và code

- [ ] Public API/SDK contract đã version.
- [ ] Backward compatibility đã kiểm tra.
- [ ] Job/effect/outcome state transition không có nhánh bất hợp lệ.
- [ ] Unknown error fail-closed.
- [ ] Không retry effect irreversible khi chưa verify.

## Dữ liệu và vận hành

- [ ] Migration theo expand → migrate → contract.
- [ ] Có backup/restore test.
- [ ] Có readiness/liveness và graceful shutdown.
- [ ] Có tenant isolation, RBAC, payload redaction và secret reference.
- [ ] Có audit cho repair/operator action.

## Kiểm thử

- [ ] Unit tests
- [ ] Contract tests cho adapters
- [ ] Integration tests với PostgreSQL
- [ ] Fault tests: kill worker, DB outage, lease expiry, duplicate delivery
- [ ] Benchmark tái lập kèm hardware, payload, worker count và workload
- [ ] Không công bố số liệu chưa có evidence

## Phát hành

- [ ] `CHANGELOG.md` cập nhật
- [ ] Docs/examples kiểm tra lại
- [ ] Rollback plan đã viết và thử
- [ ] Version/tag đã kiểm tra
- [ ] Người chịu trách nhiệm release đã xác nhận
- [ ] Branch protection và required reviews đang bật
- [ ] Secret scan không có finding
- [ ] Dependency/license scan đã xem xét
- [ ] Release chỉ từ commit đã pass CI
