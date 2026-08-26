# Embedded Task Center product campaign — 2026-08-26

Environment: Windows x64, Node v24.19.0, Go 1.26.6, Docker Desktop 4.87.0,
Docker Engine 29.7.2, PostgreSQL 16.15, Redis 7 and package
`0.1.0-beta.26`; dirty working tree under active development.

## Executed evidence

| Command/evidence | Result |
|---|---|
| `npm test` in `sdks/node` | 601 tests: 563 passed, 38 service-gated skipped, 0 failed |
| `npm run test:visual` | 11/11 passed: standalone and production React/Vite desktop/mobile, realtime identity, compact queue batching, keyboard focus, approval safety and artifact preview |
| Go 1.26.6 package campaign | every package passed; Windows Application Control required workspace-built binaries for four packages and the existing local WSL2 environment for `queuewatch` |
| `npm run fault:check` | 16/16 versioned scenario markers present |
| checkpoint worker-death scenario | recreated handler resumed from the fenced checkpoint |
| provider timeout scenario | uncertain mutation remained fail-closed |
| SSE/network-loss scenario | authoritative polling fallback converged without version regression |
| `npm run benchmark` | current raw JSON recorded in `benchmark-node-2026-08-26.json` |
| PostgreSQL integration harness | passed against the disposable PostgreSQL 16 container in 16.150 seconds |
| real retry/lost-acknowledgement drill | replacement Agent published the durable outbox command; BullMQ retained exactly one job |
| Redis/BullMQ restart drill | real connection refusal observed; Task and Execution converged to `succeeded` after restart |
| PostgreSQL SIGKILL/promotion drill | 150 acknowledgements, 150 surviving rows, 0 lost in this run, 15 FORCE RLS tables |
| PostgreSQL benchmark | concurrency/fan-out raw JSON recorded in `benchmark-postgres-2026-08-26.json` |
| adopter-shaped Go benchmark | Task Summary and 50-row Execution page measured at fan-out 100, 1,000 and 5,000 |

## Remaining deployment gate

This campaign now covers local containerized PostgreSQL, Redis/BullMQ and
multi-process Agent recovery on one host. It does not cover multi-host network
partition, witness/fencing behavior, Redis Cluster/Sentinel, real provider
credentials or a real adopter workload. The PostgreSQL failover rig promotes
on command and therefore cannot establish a production HA claim.

The Node benchmark measures only in-process projection overhead. The
PostgreSQL benchmark measures the local Task command/snapshot path, not HTTP,
provider or user-perceived end-to-end latency. No README or release claim
should turn either run into universal throughput. A release-quality capacity
statement still requires an adopter-shaped multi-host environment and recorded
configuration.
