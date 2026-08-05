#!/usr/bin/env bash
# RhinoQ PostgreSQL failover drill.
#
#   docker compose -f tests/failover/docker-compose.yml up -d
#   ./scripts/failover-drill.sh
#
# The drill answers one question and refuses to imply any others:
#
#   when the primary dies and the replica is promoted, does RhinoQ lose a write
#   it had already told a caller had succeeded?
#
# It answers it by recording every acknowledged Task id locally, killing the
# primary with SIGKILL rather than a clean shutdown, promoting the replica, and
# comparing what is there against what was promised. An acknowledged write that
# is missing afterwards is a data-loss window, and the drill prints the size of
# it rather than a verdict.
#
# WHAT THIS IS NOT
#
# One run on one laptop against two containers on the same kernel. It has no
# witness and no fencing, so it cannot distinguish a dead primary from a
# partitioned one, and it does not measure what a real deployment does under
# split brain. It is evidence about the write path, not a high-availability
# claim. See docs/production-readiness.md.
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-tests/failover/docker-compose.yml}"
PRIMARY_PORT="${PRIMARY_PORT:-55433}"
REPLICA_PORT="${REPLICA_PORT:-55434}"
WRITES="${WRITES:-500}"
TENANT="${TENANT:-tnt_drill}"
EVIDENCE_DIR="${EVIDENCE_DIR:-docs/evidence}"

primary_dsn="postgres://rhinoq:rhinoq@localhost:${PRIMARY_PORT}/rhinoq"
app_dsn="postgres://rhinoq_app:rhinoq_app@localhost:${PRIMARY_PORT}/rhinoq?options=-c%20rhinoq.tenant_id%3D${TENANT}"
replica_admin_dsn="postgres://rhinoq:rhinoq@localhost:${REPLICA_PORT}/rhinoq"

acknowledged="$(mktemp)"
trap 'rm -f "$acknowledged"' EXIT

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }
on_primary() { compose exec -T primary psql -v ON_ERROR_STOP=1 -U rhinoq -d rhinoq "$@"; }
on_replica() { compose exec -T replica psql -v ON_ERROR_STOP=1 -U rhinoq -d rhinoq "$@"; }

say() { printf '\n== %s\n' "$*"; }

say "1/7 waiting for both nodes"
for node in primary replica; do
    for _ in $(seq 1 45); do
        if compose exec -T "$node" pg_isready -U rhinoq -d rhinoq >/dev/null 2>&1; then
            printf '   %s is accepting connections\n' "$node"
            break
        fi
        sleep 2
    done
done

# A replica that is not actually streaming would make the whole drill
# meaningless — it would "survive" promotion because it was never connected.
say "2/7 confirming the replica is streaming"
streaming="$(on_primary -tAc "SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming'")"
if [ "$streaming" -lt 1 ]; then
    echo "   FAIL: no streaming standby is attached to the primary." >&2
    echo "   The drill would report zero loss for the wrong reason. Stopping." >&2
    exit 1
fi
printf '   %s standby streaming\n' "$streaming"

say "3/7 applying migrations and granting the application role"
RHINOQ_DATABASE_URL="$primary_dsn" go run ./cmd/rhinoq migrate apply >/dev/null
on_primary <<'SQL' >/dev/null
GRANT USAGE ON SCHEMA public TO rhinoq_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rhinoq_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rhinoq_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO rhinoq_app;
SQL
on_primary -c "INSERT INTO rhinoq_tenants (id, slug, name) VALUES ('${TENANT}', 'drill', 'Failover drill') ON CONFLICT (id) DO NOTHING" >/dev/null
printf '   schema applied, tenant %s created\n' "$TENANT"

say "4/7 writing ${WRITES} tasks and recording each acknowledgement"
# Each INSERT is its own transaction and its id is appended to the local log
# only after psql exits zero. The log is therefore what a caller was promised,
# which is the thing that must not be lost.
for i in $(seq 1 "$WRITES"); do
    id="task_drill_${i}"
    if compose exec -T primary env PGPASSWORD=rhinoq_app psql -v ON_ERROR_STOP=1 -q \
        -U rhinoq_app -d rhinoq \
        -c "SET rhinoq.tenant_id = '${TENANT}'" \
        -c "INSERT INTO rhinoq_tasks
              (id, type, owner_id, definition_version, state, version, created_at, updated_at)
            VALUES ('${id}', 'drill', 'drill-owner', 1, 'pending', 1, now(), now())" >/dev/null 2>&1; then
        echo "$id" >> "$acknowledged"
    fi
done
promised="$(wc -l < "$acknowledged" | tr -d ' ')"
printf '   %s writes acknowledged\n' "$promised"

replay_lag="$(on_primary -tAc "
    SELECT coalesce(max(pg_wal_lsn_diff(sent_lsn, replay_lsn)), 0)
    FROM pg_stat_replication")"
printf '   replica is %s bytes behind at the moment of the kill\n' "$replay_lag"

say "5/7 killing the primary (SIGKILL, no clean shutdown)"
compose kill -s SIGKILL primary >/dev/null
printf '   primary killed\n'

say "6/7 promoting the replica"
# pg_promote() rather than `pg_ctl promote -D <path>`: the path form is routed
# through the container by `docker compose exec`, and a Git Bash host rewrites
# the absolute path into a Windows one before docker ever sees it. The first
# version of this script did exactly that, failed, and — because the failure
# was swallowed by `|| true` — went on to report zero data loss for a failover
# that never happened. The SQL function takes no path and cannot be misread.
if ! on_replica -tAc "SELECT pg_promote(wait => true, wait_seconds => 60)" >/dev/null; then
    echo "   FAIL: the replica did not accept the promotion request." >&2
    exit 1
fi

# Confirming is not optional. A standby serves reads perfectly well while still
# in recovery, so every count in step 7 would look correct on a node that was
# never promoted. That is the difference between evidence and a screenshot.
in_recovery="$(on_replica -tAc "SELECT pg_is_in_recovery()")"
if [ "$in_recovery" != "f" ]; then
    echo "   FAIL: the replica is still in recovery after pg_promote() returned." >&2
    echo "   Refusing to report data-loss numbers measured against a standby." >&2
    exit 1
fi
printf '   replica promoted, timeline advanced, accepting writes\n'

# A promoted node that cannot take a write is not a failover target. Reads
# alone would pass every assertion below without proving the cluster recovered.
on_replica -c "CREATE TABLE IF NOT EXISTS rhinoq_failover_probe (id text PRIMARY KEY)" >/dev/null
on_replica -c "INSERT INTO rhinoq_failover_probe (id) VALUES ('promoted') ON CONFLICT DO NOTHING" >/dev/null
printf '   promoted node accepted a write\n'

say "7/7 comparing what survived against what was promised"
survived="$(on_replica -tAc "SELECT count(*) FROM rhinoq_tasks WHERE tenant_id = '${TENANT}'")"
lost=$((promised - survived))

# Isolation has to still be in force on the promoted node. A failover that
# quietly leaves the tenant boundary behind would be worse than downtime.
policies="$(on_replica -tAc "
    SELECT count(*) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname LIKE 'rhinoq%' AND c.relforcerowsecurity")"

timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
report="${EVIDENCE_DIR}/postgres-failover-$(date -u +%Y-%m-%d).md"
mkdir -p "$EVIDENCE_DIR"
cat > "$report" <<EOF
# PostgreSQL failover drill

Run ${timestamp} by \`scripts/failover-drill.sh\` on two \`postgres:16-alpine\`
containers, one primary and one streaming standby, on a single host.

| Measurement | Value |
|---|---|
| Writes acknowledged to the caller | ${promised} |
| Rows present after promotion | ${survived} |
| Acknowledged writes lost | ${lost} |
| Replica lag at the moment of the kill | ${replay_lag} bytes |
| Tables with forced row-level security after promotion | ${policies} |

The primary was killed with SIGKILL, so this exercises the crash path rather
than a clean switchover.

## What this run does not establish

- One host, one kernel, one run. Not a deployment-scale campaign.
- No witness and no fencing agent, so split brain is untested: the drill
  promotes on command rather than on a quorum decision.
- \`synchronous_commit\` is \`on\`, which makes a commit durable on the primary
  and says nothing about the replica. A deployment that needs zero loss on
  promotion has to set \`synchronous_standby_names\` and accept the latency;
  this drill measures the default, not the safe setting.
EOF

printf '\n'
printf 'acknowledged     %s\n' "$promised"
printf 'survived         %s\n' "$survived"
printf 'lost             %s\n' "$lost"
printf 'rls tables       %s\n' "$policies"
printf '\nreport written to %s\n' "$report"

if [ "$lost" -gt 0 ]; then
    printf '\nWARNING: %s acknowledged writes did not survive promotion.\n' "$lost"
    printf 'This is the expected consequence of asynchronous replication, not a bug.\n'
    printf 'Set synchronous_standby_names if that window is unacceptable.\n'
fi
if [ "$policies" -lt 1 ]; then
    printf '\nWARNING: the promoted node has no forced row-level security.\n' >&2
    exit 1
fi
