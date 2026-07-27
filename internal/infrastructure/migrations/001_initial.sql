-- RhinoQ authoritative storage. Run migrations in order.

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
    CONSTRAINT rhinoq_jobs_idempotency_unique UNIQUE (name, idempotency_key)
);

CREATE INDEX IF NOT EXISTS rhinoq_jobs_claim_idx
    ON rhinoq_jobs (state, not_before, created_at, id);

CREATE INDEX IF NOT EXISTS rhinoq_jobs_lease_idx
    ON rhinoq_jobs (state, lease_until)
    WHERE state = 'leased';

CREATE TABLE IF NOT EXISTS rhinoq_queue_controls (
    queue_name text PRIMARY KEY,
    paused_at  timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);

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
