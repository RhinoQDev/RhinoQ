# Redis/BullMQ restart evidence — 2026-08-05

This is one local process-restart run, not a production reliability or
throughput claim. It used the disposable `redis:7-alpine` container
`rhinoq-chaos-redis` on port `6398`, PostgreSQL 16 in the local evaluation
container on port `55432`, and the checked-out `examples/fanout-bullmq`
source.

Command shape:

```bash
docker run -d --name rhinoq-chaos-redis -p 6398:6379 redis:7-alpine
RHINOQ_DATABASE_URL='postgres://rhinoq:rhinoq@127.0.0.1:55432/rhinoq?sslmode=disable' \
REDIS_URL='redis://127.0.0.1:6398' \
RHINOQ_CHAOS_REDIS_CONTAINER='rhinoq-chaos-redis' npm run chaos
docker rm -f rhinoq-chaos-redis
```

Observed result:

```text
scenario: redis-bullmq-process-restart
Task state: succeeded
Execution state: succeeded
Redis container: rhinoq-chaos-redis
```

The run also observed expected reconnect errors while Redis was stopped. The
harness waits for Redis to return, then verifies Task convergence and cleans up
the Task and container. It does not cover PostgreSQL failover, network
partitions, concurrent production load or design-partner code reduction.
