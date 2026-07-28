# Project context

## Sản phẩm

RhinoQ là PostgreSQL job queue có business-integrity workflow: tương quan intent/job/effect, xác minh business outcome và phục hồi sai lệch. Queue là core product; `scan`/observe-only là đường đánh giá trên execution system hiện hữu.

## Mục tiêu hiện tại

- Xây Go modular monolith trước; TypeScript chỉ là SDK/CLI developer-facing.
- Giữ dependency một chiều giữa contracts, domain, application, runtime, ports, adapters và infrastructure.
- Chưa tuyên bố throughput/latency production khi chưa có benchmark tái lập.
- PostgreSQL là authoritative store mặc định.
- Embedded Go là deployment mặc định: application dùng `*rhinoq.Client` trực
  tiếp với PostgreSQL, không cần server riêng.
- `rhinoq-agent` chỉ là HTTP Gateway tùy chọn cho worker không phải Go; nó
  không phải AI agent và RhinoQ không cần LLM.

## Thuật ngữ bắt buộc

- `request accepted`: provider đã nhận request.
- `effect confirmed`: có bằng chứng effect đã hoàn thành.
- `outcome achieved`: business invariant đã đạt.
- `uncertain`: chưa đủ bằng chứng; không được coi là success.
- `irreversible`: thuộc tính của từng effect, không phải của toàn bộ job.

## Trạng thái scaffold

Đã có Go engine/domain/application/ports, PostgreSQL adapter, worker runtime,
Rule scheduler, Finding inbox và CLI vận hành trực tiếp. TypeScript chỉ là
client cho HTTP Gateway tùy chọn. Console, scan/correlation và protocol
generation chưa hoàn thiện.
