-- RhinoQ authoritative storage. Run migrations in order.
SET search_path = public;

CREATE TABLE IF NOT EXISTS rhinoq_jobs (
    id                 text PRIMARY KEY,
    name               text NOT NULL,
    payload            bytea NOT NULL,
    state              text NOT NULL CHECK (state IN ('pending', 'leased', 'succeeded', 'retry_wait', 'dead', 'cancelled', 'blocked')),
    attempts           integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    idempotency_key    text,
    correlation_id     text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    not_before         timestamptz NOT NULL DEFAULT now(),
    lease_id           text,
    lease_until        timestamptz,
    cancel_requested   boolean NOT NULL DEFAULT false,
    CONSTRAINT rhinoq_jobs_idempotency_unique UNIQUE (name, idempotency_key)
);

ALTER TABLE rhinoq_jobs
    ADD COLUMN IF NOT EXISTS cancel_requested boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS rhinoq_jobs_claim_idx
    ON rhinoq_jobs (state, not_before, created_at, id);

CREATE INDEX IF NOT EXISTS rhinoq_jobs_lease_idx
    ON rhinoq_jobs (state, lease_until)
    WHERE state = 'leased';

CREATE TABLE IF NOT EXISTS rhinoq_queue_controls (
    queue_name             text PRIMARY KEY,
    paused_at              timestamptz,
    rate_limit_max         integer CHECK (rate_limit_max > 0),
    rate_limit_window_ms   bigint CHECK (rate_limit_window_ms > 0),
    rate_window_started_at timestamptz,
    rate_window_count      integer NOT NULL DEFAULT 0 CHECK (rate_window_count >= 0),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE rhinoq_queue_controls
    ADD COLUMN IF NOT EXISTS rate_limit_max integer,
    ADD COLUMN IF NOT EXISTS rate_limit_window_ms bigint,
    ADD COLUMN IF NOT EXISTS rate_window_started_at timestamptz,
    ADD COLUMN IF NOT EXISTS rate_window_count integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS rhinoq_effects (
    id                 text PRIMARY KEY,
    job_id             text NOT NULL REFERENCES rhinoq_jobs(id),
    name               text NOT NULL,
    idempotency_key    text NOT NULL,
    state              text NOT NULL CHECK (state IN ('pending', 'confirmed', 'uncertain', 'rejected', 'not_happened')),
    irreversible       boolean NOT NULL DEFAULT false,
    external_ref       text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (job_id, name, idempotency_key)
);

CREATE TABLE IF NOT EXISTS rhinoq_outcomes (
    id                 text PRIMARY KEY,
    job_id             text NOT NULL REFERENCES rhinoq_jobs(id),
    contract_version   integer NOT NULL,
    state              text NOT NULL CHECK (state IN ('pending', 'achieved', 'mismatch', 'unverifiable', 'stale')),
    reason             text,
    observed_version   bigint NOT NULL DEFAULT 0,
    updated_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (job_id, contract_version)
);

CREATE TABLE IF NOT EXISTS rhinoq_outbox (
    id                 bigserial PRIMARY KEY,
    aggregate_type     text NOT NULL,
    aggregate_id       text NOT NULL,
    event_type         text NOT NULL,
    payload            jsonb NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    published_at       timestamptz,
    claimed_at         timestamptz,
    claim_id           text
);

CREATE INDEX IF NOT EXISTS rhinoq_outbox_pending_idx
    ON rhinoq_outbox (created_at, id)
    WHERE published_at IS NULL AND claimed_at IS NULL;

CREATE TABLE IF NOT EXISTS rhinoq_audit (
    sequence    bigserial UNIQUE,
    id          text PRIMARY KEY,
    job_id      text NOT NULL REFERENCES rhinoq_jobs(id),
    action      text NOT NULL CHECK (btrim(action) <> ''),
    actor       text NOT NULL CHECK (btrim(actor) <> ''),
    reason      text NOT NULL CHECK (btrim(reason) <> ''),
    occurred_at timestamptz NOT NULL,
    prev_hash   text NOT NULL DEFAULT '' CHECK (prev_hash = '' OR length(prev_hash) = 64),
    row_hash    text NOT NULL CHECK (length(row_hash) = 64),
    metadata    jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS rhinoq_audit_job_timeline_idx
    ON rhinoq_audit (job_id, sequence DESC);
