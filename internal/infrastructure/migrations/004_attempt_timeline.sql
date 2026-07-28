-- RhinoQ migration 004: immutable execution evidence.
--
-- rhinoq_jobs remains the small, mutable hot-state table used by workers.
-- This table is the append-only timeline used by audit, support and future
-- read models. A lease epoch identifies the execution even when a released
-- reservation gives its numeric attempt back to the job.
SET search_path = public;

CREATE TABLE IF NOT EXISTS public.rhinoq_attempt_events (
    sequence       bigserial PRIMARY KEY,
    job_id         text NOT NULL REFERENCES public.rhinoq_jobs(id) ON DELETE CASCADE,
    attempt_number integer NOT NULL CHECK (attempt_number > 0),
    lease_owner    text NOT NULL CHECK (btrim(lease_owner) <> ''),
    lease_epoch    bigint NOT NULL CHECK (lease_epoch > 0),
    kind           text NOT NULL CHECK (kind IN (
        'claimed', 'succeeded', 'retry_scheduled', 'dead', 'blocked',
        'cancelled', 'released', 'lease_expired'
    )),
    result_state   text CHECK (result_state IS NULL OR result_state IN (
        'pending', 'leased', 'succeeded', 'retry_wait', 'dead',
        'cancelled', 'blocked'
    )),
    failure_class  text,
    blocked_reason text,
    occurred_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rhinoq_attempt_events_job_timeline_idx
    ON rhinoq_attempt_events (job_id, sequence);

-- Evidence may be removed only by an explicit retention operation; it may
-- never be rewritten in place.
CREATE OR REPLACE FUNCTION rhinoq_reject_attempt_event_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'rhinoq_attempt_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS rhinoq_attempt_events_no_update ON rhinoq_attempt_events;
CREATE TRIGGER rhinoq_attempt_events_no_update
BEFORE UPDATE ON rhinoq_attempt_events
FOR EACH ROW EXECUTE FUNCTION rhinoq_reject_attempt_event_update();
