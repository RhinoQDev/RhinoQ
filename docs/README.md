# RhinoQ documentation

## Bắt đầu

- [The detector](../examples/integrity-only/) — cửa vào: một lệnh, một role
  read-only, không migration nào chạy trên database của ứng dụng
- [Start here: câu chuyện, lệnh chạy, dashboard và hướng tích hợp đầy đủ](./start-here.md)
- [Product positioning: ai dùng, giải quyết gì, claim nào được phép](./product-positioning.md)
- [Getting started](./getting-started.md)
- [Existing-queue evaluation protocol](./evaluation-existing-queue.md) — use a
  second real application and return comparable adoption evidence
- [CLI command reference](./cli.md)
- [Node.js integration](./nodejs.md)
- [Configuration](./configuration.md)
- [PostgreSQL production client](./postgres.md)
- [Architecture](./architecture.md)
- [Architecture review and repository organization](./architecture-review.md)
- [Runtime flows và ranh giới tầng](./runtime-flows.md)
- [HTTP Gateway tùy chọn và tích hợp đa ngôn ngữ (không AI/LLM)](./agent.md)
- [Security audit 2026-07-29](./security-audit-2026-07-29.md)

## Vận hành

- [Runtime operations](./operations.md)
- [Reproducible benchmarks and fault evidence](./benchmarks.md)
- [Finding webhook and Slack notifications](./notifications.md)
- [Failure semantics](./failure-semantics.md)
- [Recovery](./recovery.md)
- [Release checklist](../.ai/RELEASE_CHECKLIST.md)

## Thiết kế

- [Task Platform architecture history and current status table](./task-platform.md)
- [Product evidence and validation log](./product-evidence.md)
- [Implemented product strengths and proof boundaries](./product-strengths.md)
- [Runtime foundation and implementation matrix](./feature-matrix.md)
- [Integrity Rules](./rules.md)
- [ProviderOperation](./provider-operations.md)
- [Safe repair workflow](./safe-repair.md)
- [First three design partners](./design-partners.md)
- [Competitive landscape](./competitive-landscape.md)
- [Adoption and usability review](./adoption-review.md)
- [The adoption gap](./adoption-gap.md) — what limits adoption now that the
  contract no longer does
- [Measuring plumbing](./measuring-plumbing.md) — how the "materially less
  plumbing" claim will be checked, and why it is still unmeasured
- [Roadmap](./roadmap.md)
- [Architecture decision records](../.ai/DECISIONS.md)

## Optional Verified Tasks

- [The detector (integrity-only example)](../examples/integrity-only/)
- [Integrity Rules](./rules.md)
- [Recovery boundary](./recovery.md)

Tài liệu phải phân biệt rõ: documented, implemented, tested và production-evidenced.
