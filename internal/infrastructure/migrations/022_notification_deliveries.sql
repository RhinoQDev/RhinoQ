-- Durable notification deduplication and delivery audit.
SET search_path = public;

CREATE TABLE IF NOT EXISTS rhinoq_notification_deliveries (
    id              text PRIMARY KEY CHECK (btrim(id) <> ''),
    event_id        text NOT NULL CHECK (btrim(event_id) <> ''),
    destination_id  text NOT NULL CHECK (btrim(destination_id) <> ''),
    state           text NOT NULL CHECK (state IN ('pending','sent','failed')),
    attempts        integer NOT NULL CHECK (attempts > 0),
    last_error      text,
    version         bigint NOT NULL CHECK (version > 0),
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL,
    sent_at         timestamptz,
    UNIQUE (event_id,destination_id),
    CHECK (last_error IS NULL OR octet_length(last_error) <= 4096)
);

CREATE INDEX IF NOT EXISTS rhinoq_notification_deliveries_retry_idx
    ON rhinoq_notification_deliveries (updated_at,id)
    WHERE state='failed';
