# Redis/BullMQ restart evidence — 2026-08-26

Run on Windows with Docker Desktop 4.87.0, Engine 29.7.2 and a disposable
`redis:7-alpine` container named `rhinoq-chaos-redis-20260826` on port 6398.
PostgreSQL 16.15 ran in a separate disposable container on port 55432.

The harness dispatched one BullMQ-backed Task, waited until its worker became
active, stopped Redis, observed real `ECONNREFUSED` errors across the Worker,
QueueEvents and bridge connections, restarted Redis and waited for the
authoritative Task projection to converge.

| Measurement | Value |
|---|---|
| Scenario | `redis-bullmq-process-restart` |
| Task state after restart | `succeeded` |
| Execution state after restart | `succeeded` |
| Redis connection loss observed | yes (`ECONNREFUSED`) |

The same campaign also ran the real retry fault test. Its first Agent delivered
an outbox event to BullMQ but lost the HTTP acknowledgement and exited. The
outbox row stayed unpublished. A replacement Agent redelivered the same
command, after which the row became published and BullMQ contained exactly one
job with the Execution identity.

This is one local single-host restart campaign, not an availability or
throughput claim. It does not cover multi-host partition, Redis Cluster/Sentinel
promotion, provider infrastructure or production concurrency.
