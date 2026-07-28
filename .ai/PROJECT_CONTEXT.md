# Project context

## Sản phẩm

RhinoQ là PostgreSQL job queue có business-integrity workflow: tương quan intent/job/effect, xác minh business outcome và phục hồi sai lệch. Queue là core product; `scan`/observe-only là đường đánh giá trên execution system hiện hữu.

## Mục tiêu hiện tại

- Xây Go modular monolith trước; TypeScript chỉ là SDK/CLI developer-facing.
- Giữ dependency một chiều giữa contracts, domain, application, runtime, ports, adapters và infrastructure.
- Chưa tuyên bố throughput/latency production khi chưa có benchmark tái lập.
- PostgreSQL là authoritative store mặc định.

## Thuật ngữ bắt buộc

- `request accepted`: provider đã nhận request.
- `effect confirmed`: có bằng chứng effect đã hoàn thành.
- `outcome achieved`: business invariant đã đạt.
- `uncertain`: chưa đủ bằng chứng; không được coi là success.
- `irreversible`: thuộc tính của từng effect, không phải của toàn bộ job.

## Trạng thái scaffold

Đã có scaffold Go cho engine/domain/application/ports, cùng TypeScript SDK scaffold. PostgreSQL adapter, worker runtime đầy đủ, Console và protocol generation chưa hoàn thiện.
