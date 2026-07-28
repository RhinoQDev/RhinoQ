-- Durable, fenced cursors for periodic table-scoped Rule evaluation.
SET search_path = public;

CREATE TABLE IF NOT EXISTS rhinoq_rule_schedules (
    rule_id             text NOT NULL,
    rule_version        integer NOT NULL,
    cursor              text NOT NULL DEFAULT '',
    next_run_at         timestamptz NOT NULL DEFAULT now(),
    lease_owner         text,
    lease_epoch         bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
    lease_expires_at    timestamptz,
    last_started_at     timestamptz,
    last_completed_at   timestamptz,
    last_error          text NOT NULL DEFAULT '' CHECK (octet_length(last_error) <= 4096),
    PRIMARY KEY (rule_id, rule_version),
    FOREIGN KEY (rule_id, rule_version)
        REFERENCES rhinoq_rules (id, version)
        ON DELETE CASCADE,
    CHECK (
        (lease_owner IS NULL AND lease_expires_at IS NULL)
        OR (btrim(lease_owner) <> '' AND lease_expires_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS rhinoq_rule_schedules_due_idx
    ON rhinoq_rule_schedules (next_run_at, lease_expires_at);

-- Upgrade safety: an enabled Rule created before this migration must become
-- schedulable without waiting for a definition rewrite.
INSERT INTO rhinoq_rule_schedules (rule_id, rule_version, next_run_at)
SELECT id, version, clock_timestamp()
FROM rhinoq_rules
WHERE scope = 'table' AND status = 'enabled'
ON CONFLICT (rule_id, rule_version) DO NOTHING;
