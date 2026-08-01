-- Durable, idempotent provider calls with explicit unknown outcomes.
SET search_path = public;

CREATE TABLE IF NOT EXISTS rhinoq_provider_operations (
    id                text PRIMARY KEY CHECK (btrim(id) <> ''),
    provider          text NOT NULL CHECK (btrim(provider) <> '' AND octet_length(provider) <= 64),
    operation         text NOT NULL CHECK (btrim(operation) <> '' AND octet_length(operation) <= 128),
    idempotency_key   text NOT NULL CHECK (btrim(idempotency_key) <> '' AND octet_length(idempotency_key) <= 256),
    state             text NOT NULL CHECK (state IN ('pending','accepted','confirmed','not_happened','rejected','uncertain')),
    provider_id       text,
    evidence          text,
    reason            text,
    version           bigint NOT NULL CHECK (version > 0),
    created_at        timestamptz NOT NULL,
    updated_at        timestamptz NOT NULL,
    UNIQUE (provider, operation, idempotency_key),
    CHECK (provider_id IS NULL OR octet_length(provider_id) <= 512),
    CHECK (evidence IS NULL OR octet_length(evidence) <= 4096),
    CHECK (reason IS NULL OR octet_length(reason) <= 4096)
);

CREATE INDEX IF NOT EXISTS rhinoq_provider_operations_attention_idx
    ON rhinoq_provider_operations (updated_at, id)
    WHERE state IN ('accepted', 'uncertain');
