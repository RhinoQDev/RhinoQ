# Real retry fault drill

This drill needs Docker Desktop with the Linux container engine running. It
starts PostgreSQL on `127.0.0.1:55432` and Redis on `127.0.0.1:56379`; no host
PostgreSQL or Redis service is required.

```powershell
docker compose -f tests/postgres/docker-compose.yml up -d --wait
docker compose -f tests/runtime-retry/docker-compose.yml up -d --wait

$env:RHINOQ_TEST_DATABASE_URL='postgres://rhinoq:rhinoq@localhost:55432/rhinoq?sslmode=disable'
Push-Location tests/postgres
go test -count=1 ./...
Pop-Location

go build -buildvcs=false -o .tmp-bin/rhinoq-agent.exe ./cmd/rhinoq-agent
$env:RHINOQ_REAL_RETRY_FAULT='1'
$env:RHINOQ_AGENT_BINARY=(Resolve-Path '.tmp-bin/rhinoq-agent.exe').Path
$env:RHINOQ_AGENT_TEST_DATABASE_URL='postgres://rhinoq_app:rhinoq_app@localhost:55432/rhinoq?sslmode=disable&options=-c%20rhinoq.tenant_id%3Dtnt_system'
Push-Location sdks/node
# BullMQ/ioredis are test-only optional dependencies when not already present.
npm install --no-save bullmq ioredis
node --test test/real-retry-fault.test.mjs
Pop-Location
```

The endpoint accepts `Queue.add()`, then destroys the first HTTP connection
before acknowledgement. The first Agent must stop while PostgreSQL keeps the
outbox row unpublished. A replacement Agent redelivers it; BullMQ must still
contain one job with the Execution id, and the outbox row must become
published.

Cleanup removes only these test stacks and their anonymous volumes:

```powershell
docker compose -f tests/runtime-retry/docker-compose.yml down -v
docker compose -f tests/postgres/docker-compose.yml down -v
```
