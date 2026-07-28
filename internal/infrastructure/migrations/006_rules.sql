-- Canonical integrity Rules. Definitions are append-only by (id, version);
-- enabling a new version disables the old one.
SET search_path = public;

ALTER TABLE rhinoq_finding_events
    DROP CONSTRAINT IF EXISTS rhinoq_finding_events_kind_check;

ALTER TABLE rhinoq_finding_events
    ADD CONSTRAINT rhinoq_finding_events_kind_check
    CHECK (kind IN ('observed', 'transitioned', 'passed'));

CREATE TABLE IF NOT EXISTS rhinoq_rules (
    id                    text NOT NULL CHECK (
        btrim(id) <> '' AND octet_length(id) <= 128
    ),
    version               integer NOT NULL CHECK (version > 0),
    name                  text NOT NULL CHECK (
        btrim(name) <> '' AND octet_length(name) <= 200
    ),
    scope                 text NOT NULL CHECK (scope IN ('job', 'table')),
    status                text NOT NULL CHECK (status IN ('draft', 'enabled', 'disabled')),
    subject_type          text NOT NULL CHECK (
        btrim(subject_type) <> '' AND octet_length(subject_type) <= 64
    ),
    job_name              text NOT NULL DEFAULT '' CHECK (octet_length(job_name) <= 128),
    query                 text NOT NULL CHECK (
        btrim(query) <> '' AND octet_length(query) <= 32768
    ),
    baseline_at           timestamptz,
    every_ms              bigint NOT NULL DEFAULT 0 CHECK (every_ms >= 0),
    within_ms             bigint NOT NULL DEFAULT 0 CHECK (within_ms >= 0),
    max_rows              integer NOT NULL CHECK (max_rows BETWEEN 1 AND 1000),
    statement_timeout_ms  bigint NOT NULL CHECK (
        statement_timeout_ms BETWEEN 1 AND 30000
    ),
    max_plan_cost         double precision NOT NULL CHECK (max_plan_cost > 0),
    max_seq_scan_rows     bigint NOT NULL CHECK (max_seq_scan_rows > 0),
    created_at            timestamptz NOT NULL,
    updated_at            timestamptz NOT NULL,
    PRIMARY KEY (id, version),
    CHECK (scope <> 'job' OR btrim(job_name) <> ''),
    CHECK (
        scope <> 'table'
        OR (baseline_at IS NOT NULL AND every_ms > 0)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS rhinoq_rules_one_enabled_version_idx
    ON rhinoq_rules (id)
    WHERE status = 'enabled';

CREATE INDEX IF NOT EXISTS rhinoq_rules_latest_idx
    ON rhinoq_rules (id, version DESC);

CREATE INDEX IF NOT EXISTS rhinoq_rules_scheduler_idx
    ON rhinoq_rules (scope, status, updated_at)
    WHERE status = 'enabled';

CREATE TABLE IF NOT EXISTS rhinoq_rule_explanations (
    rule_id          text NOT NULL,
    rule_version     integer NOT NULL,
    query_hash       text NOT NULL CHECK (length(query_hash) = 64),
    safe             boolean NOT NULL,
    plan_cost        double precision NOT NULL,
    estimated_rows   bigint NOT NULL,
    seq_scans        jsonb NOT NULL DEFAULT '[]'::jsonb,
    reasons          jsonb NOT NULL DEFAULT '[]'::jsonb,
    explained_at     timestamptz NOT NULL,
    PRIMARY KEY (rule_id, rule_version),
    FOREIGN KEY (rule_id, rule_version)
        REFERENCES rhinoq_rules (id, version)
        ON DELETE CASCADE
);
