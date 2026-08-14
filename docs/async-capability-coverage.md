# Async capability coverage

RhinoQ covers processing concerns through stable capabilities; it does not add
every product named in an ecosystem map. Kafka, RabbitMQ, NATS, Temporal,
Kubernetes and a CDN are deployment choices, not checkboxes inside a Task SDK.

| Concern from the ecosystem map | RhinoQ coverage | Boundary |
|---|---|---|
| Task state, attempts, progress, result, cancel | implemented | PostgreSQL Task profile + runtime adapter |
| Queue, retry, delay, priority, scheduling | implemented | native PostgreSQL or adapter capability |
| Idempotency, leases, dedup, reconciliation | implemented | Go engine is authoritative |
| Batch and fan-out/fan-in settlement | implemented | bounded declarations and item settlement |
| BullMQ / custom runtime / SQS | implemented at different maturity | BullMQ production path; SQS proof adapter |
| Complex workflow language and Saga DSL | intentionally not built | compose Tasks/waitpoints/effects or use Temporal/Step Functions |
| Direct/resumable upload and object storage | implemented | S3/R2/MinIO/Spaces; Cloudinary provider has its supported subset |
| Large download and backpressure | implemented | `context.io.download()` requires HTTPS allowlist, timeout and byte bound |
| Temporary processing files | implemented | opt-in isolated `workspace`, capacity check and `finally` cleanup |
| Video probe/transcode/thumbnail | implemented | FFprobe/FFmpeg installed by worker image |
| Image/PDF/Office/AI processing | integration-ready | business handler chooses Sharp/LibreOffice/model provider; outputs use artifacts |
| SSE, polling and embedded UI | implemented | SSE is primary; polling fallback; WebSocket not required for one-way progress |
| Durable input/approval/webhook wait | implemented | versioned PostgreSQL waitpoints |
| Selective execution resume | bounded opt-in contract | checksum/handler-version-fenced PostgreSQL checkpoints; not a workflow engine or effect ledger |
| Outbound notifications | implemented | signed webhook/Slack delivery ledger; email/SMS provider remains application-owned |
| Effect confirmation and business verification | implemented | explicit idempotency + readback/webhook/predicate; unknown is `uncertain` |
| Outbox and repair | implemented | durable engine paths and guarded operator workflow |
| Rate limit, concurrency, queue fairness | capability-dependent | runtime/lane policy; per-plan SaaS quotas remain application admission policy |
| Metrics, health, tracing and diagnostics | implemented | dependency-free metrics/hooks; adopter connects Prometheus/OpenTelemetry/Sentry |
| Graceful shutdown and worker drain | implemented | worker lifecycle capability |
| Authentication and tenancy | integrated boundary | host authentication supplies owner/tenant; RhinoQ fences reads and writes |
| Malware scan, DLP and content moderation | integration-ready, not automatic | declare a scan Task before downstream processing |
| CDN, lifecycle/versioning and storage class | provider policy | RhinoQ stores private references and issues short-lived access |
| Docker worker | implemented example | non-root FFmpeg base included |
| Kubernetes, KEDA, serverless and IaC | deployment-owned | consume queue depth/wait/health metrics; no forced orchestrator |
| Secrets | environment/provider-owned | never stored in Task payload, generated config or notification registry |
| CDC/event sourcing/CQRS | outside core | connect through adapters/outbox without changing Task semantics |

The important production guarantee is behavioral: a handler may download,
probe/process, upload, report progress, pause for external input, resume, retry
and reconcile without reimplementing Task lifecycle. RhinoQ does not claim to
replace specialized media, malware, workflow or infrastructure products.
