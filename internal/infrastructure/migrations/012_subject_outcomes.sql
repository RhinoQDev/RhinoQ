-- Canonical integrity state for one Rule version and one business subject.
-- Legacy rhinoq_outcomes remains execution/job evidence; Rules project through
-- this table before they open or resolve operational Findings.
SET search_path = public;

ALTER TABLE rhinoq_rules
    ADD COLUMN IF NOT EXISTS unknown_grace_ms bigint NOT NULL DEFAULT 0;

ALTER TABLE rhinoq_rules
    DROP CONSTRAINT IF EXISTS rhinoq_rules_unknown_grace_check;
ALTER TABLE rhinoq_rules
    ADD CONSTRAINT rhinoq_rules_unknown_grace_check
    CHECK (
        unknown_grace_ms BETWEEN 0 AND 2592000000
        AND (on_unknown = 'finding' OR unknown_grace_ms = 0)
    );

CREATE TABLE IF NOT EXISTS rhinoq_subject_outcomes (
    rule_id           text NOT NULL,
    rule_version      integer NOT NULL,
    subject_type      text NOT NULL,
    subject_id        text NOT NULL,
    status            text NOT NULL CHECK (
        status IN ('passed', 'violated', 'unknown')
    ),
    reason            text,
    evidence          text,
    first_unknown_at  timestamptz,
    last_observed_at  timestamptz NOT NULL,
    unknown_count     integer NOT NULL DEFAULT 0 CHECK (unknown_count >= 0),
    updated_at        timestamptz NOT NULL,
    PRIMARY KEY (rule_id, rule_version, subject_type, subject_id),
    FOREIGN KEY (rule_id, rule_version)
        REFERENCES rhinoq_rules (id, version)
        ON DELETE CASCADE,
    CHECK (
        (status = 'unknown' AND first_unknown_at IS NOT NULL AND unknown_count > 0)
        OR
        (status <> 'unknown' AND first_unknown_at IS NULL AND unknown_count = 0)
    )
);

CREATE INDEX IF NOT EXISTS rhinoq_subject_outcomes_unknown_idx
    ON rhinoq_subject_outcomes (rule_id, rule_version, first_unknown_at)
    WHERE status = 'unknown';

CREATE INDEX IF NOT EXISTS rhinoq_subject_outcomes_subject_idx
    ON rhinoq_subject_outcomes (subject_type, subject_id, updated_at DESC);
