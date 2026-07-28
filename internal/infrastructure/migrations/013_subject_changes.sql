-- Durable signal-first verification input. changed_at + subject_id + id is the
-- stable incremental cursor; scheduled Rule scans remain the correctness
-- fallback when an application fails to publish a signal.
SET search_path = public;

CREATE TABLE IF NOT EXISTS rhinoq_subject_changes (
    id            bigserial PRIMARY KEY,
    subject_type  text NOT NULL CHECK (
        btrim(subject_type) <> '' AND octet_length(subject_type) <= 64
    ),
    subject_id    text NOT NULL CHECK (
        btrim(subject_id) <> '' AND octet_length(subject_id) <= 256
    ),
    business_key  text CHECK (octet_length(business_key) <= 256),
    changed_at    timestamptz NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    processed_at  timestamptz,
    last_error    text
);

CREATE INDEX IF NOT EXISTS rhinoq_subject_changes_pending_idx
    ON rhinoq_subject_changes (changed_at, subject_id, id)
    WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS rhinoq_subject_changes_subject_idx
    ON rhinoq_subject_changes (subject_type, subject_id, changed_at DESC);
