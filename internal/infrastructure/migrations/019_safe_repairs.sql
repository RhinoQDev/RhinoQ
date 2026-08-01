-- Auditable repair plans. Business mutations remain in application-registered
-- handlers; this table stores the approval fence and execution evidence only.
SET search_path = public;
CREATE TABLE IF NOT EXISTS rhinoq_repairs (
    id text PRIMARY KEY CHECK (btrim(id) <> ''),
    rule_id text NOT NULL,
    subject_type text NOT NULL,
    subject_id text NOT NULL,
    invariant_version integer NOT NULL,
    handler text NOT NULL CHECK (btrim(handler) <> ''),
    parameters jsonb NOT NULL,
    state text NOT NULL CHECK (state IN ('proposed','previewed','approved','running','succeeded','failed','stale','uncertain')),
    proposed_by text NOT NULL CHECK (btrim(proposed_by) <> ''),
    approved_by text,
    approval_reason text,
    preview text,
    precondition text,
    outcome text,
    version bigint NOT NULL CHECK (version > 0),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    FOREIGN KEY (rule_id, subject_type, subject_id, invariant_version)
      REFERENCES rhinoq_findings(rule_id, subject_type, subject_id, invariant_version),
    CHECK (approved_by IS NULL OR approved_by <> proposed_by),
    CHECK (state NOT IN ('approved','running','succeeded','failed','stale','uncertain') OR approved_by IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS rhinoq_repairs_finding_idx ON rhinoq_repairs(rule_id,subject_type,subject_id,invariant_version,updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS rhinoq_repairs_one_active_per_finding
    ON rhinoq_repairs(rule_id,subject_type,subject_id,invariant_version)
    WHERE state IN ('proposed','previewed','approved','running');
