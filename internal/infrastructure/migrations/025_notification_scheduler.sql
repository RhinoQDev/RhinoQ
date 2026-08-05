-- Durable multi-node notification scheduling. A row lease is the ownership
-- fence; no process-local cron state is authoritative.
SET search_path = public;

ALTER TABLE rhinoq_notification_deliveries
    DROP CONSTRAINT IF EXISTS rhinoq_notification_deliveries_state_check;

ALTER TABLE rhinoq_notification_deliveries
    ADD CONSTRAINT rhinoq_notification_deliveries_state_check
    CHECK (state IN ('pending','sent','failed','dead'));

ALTER TABLE rhinoq_notification_deliveries
    ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ADD COLUMN IF NOT EXISTS lease_owner text,
    ADD COLUMN IF NOT EXISTS lease_until timestamptz,
    ADD COLUMN IF NOT EXISTS message_payload jsonb;

CREATE INDEX IF NOT EXISTS rhinoq_notification_deliveries_claim_idx
    ON rhinoq_notification_deliveries (next_attempt_at,id)
    WHERE state IN ('pending','failed');
