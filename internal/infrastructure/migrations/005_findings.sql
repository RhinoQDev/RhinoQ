-- Persistent integrity findings and their append-only lifecycle evidence.
SET search_path = public;

CREATE TABLE IF NOT EXISTS rhinoq_findings (
    rule_id            text NOT NULL CHECK (btrim(rule_id) <> '' AND octet_length(rule_id) <= 128),
    subject_type       text NOT NULL CHECK (btrim(subject_type) <> '' AND octet_length(subject_type) <= 64),
    subject_id         text NOT NULL CHECK (btrim(subject_id) <> '' AND octet_length(subject_id) <= 256),
    invariant_version  integer NOT NULL CHECK (invariant_version >= 0),
    status             text NOT NULL CHECK (status IN (
        'open', 'acknowledged', 'repair_proposed', 'repairing',
        'resolved', 'false_positive', 'ignored', 'regressed'
    )),
    first_seen         timestamptz NOT NULL,
    last_seen          timestamptz NOT NULL,
    occurrence_count   bigint NOT NULL CHECK (occurrence_count > 0),
    latest_evidence    text NOT NULL DEFAULT '' CHECK (octet_length(latest_evidence) <= 65536),
    actor              text NOT NULL DEFAULT '' CHECK (octet_length(actor) <= 256),
    reason             text NOT NULL DEFAULT '' CHECK (octet_length(reason) <= 4096),
    suppressed_until   timestamptz,
    resolved_at        timestamptz,
    updated_at         timestamptz NOT NULL,
    PRIMARY KEY (rule_id, subject_type, subject_id, invariant_version),
    CHECK (
        status NOT IN ('false_positive', 'ignored')
        OR suppressed_until IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS rhinoq_findings_inbox_idx
    ON rhinoq_findings (status, updated_at DESC)
    WHERE status NOT IN ('resolved');

CREATE INDEX IF NOT EXISTS rhinoq_findings_subject_idx
    ON rhinoq_findings (subject_type, subject_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS rhinoq_finding_events (
    sequence           bigserial PRIMARY KEY,
    rule_id            text NOT NULL,
    subject_type       text NOT NULL,
    subject_id         text NOT NULL,
    invariant_version  integer NOT NULL,
    kind               text NOT NULL CHECK (kind IN ('observed', 'transitioned')),
    from_status        text NOT NULL DEFAULT '',
    to_status          text NOT NULL,
    actor              text NOT NULL DEFAULT '' CHECK (octet_length(actor) <= 256),
    reason             text NOT NULL DEFAULT '' CHECK (octet_length(reason) <= 4096),
    evidence           text NOT NULL DEFAULT '' CHECK (octet_length(evidence) <= 65536),
    suppressed_until   timestamptz,
    occurred_at        timestamptz NOT NULL,
    FOREIGN KEY (rule_id, subject_type, subject_id, invariant_version)
        REFERENCES rhinoq_findings (
            rule_id, subject_type, subject_id, invariant_version
        )
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS rhinoq_finding_events_timeline_idx
    ON rhinoq_finding_events (
        rule_id, subject_type, subject_id, invariant_version, sequence DESC
    );
