# PostgreSQL failover drill

Run 2026-08-26T06:52:36Z by `scripts/failover-drill.sh` on two `postgres:16-alpine`
containers, one primary and one streaming standby, on a single host.

| Measurement | Value |
|---|---|
| Writes acknowledged to the caller | 150 |
| Rows present after promotion | 150 |
| Acknowledged writes lost | 0 |
| Replica lag at the moment of the kill | 0 bytes |
| Tables with forced row-level security after promotion | 15 |

The primary was killed with SIGKILL, so this exercises the crash path rather
than a clean switchover.

## What this run does not establish

- One host, one kernel, one run. Not a deployment-scale campaign.
- No witness and no fencing agent, so split brain is untested: the drill
  promotes on command rather than on a quorum decision.
- `synchronous_commit` is `on`, which makes a commit durable on the primary
  and says nothing about the replica. A deployment that needs zero loss on
  promotion has to set `synchronous_standby_names` and accept the latency;
  this drill measures the default, not the safe setting.
