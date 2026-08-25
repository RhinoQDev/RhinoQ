-- Best-effort wake hints for idle workers. PostgreSQL emits NOTIFY only after
-- the surrounding transaction commits. Queue state and claim fencing remain
-- authoritative; workers retain polling for reconnects and delayed jobs.
CREATE OR REPLACE FUNCTION rhinoq_notify_job_ready()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.state IN ('pending', 'retry_wait') AND NEW.not_before <= now() THEN
        IF TG_OP = 'INSERT' THEN
            PERFORM pg_notify('rhinoq_job_ready', NEW.queue_name);
        ELSIF OLD.state IS DISTINCT FROM NEW.state OR OLD.not_before IS DISTINCT FROM NEW.not_before THEN
            PERFORM pg_notify('rhinoq_job_ready', NEW.queue_name);
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rhinoq_jobs_ready_notify ON rhinoq_jobs;
CREATE TRIGGER rhinoq_jobs_ready_notify
AFTER INSERT OR UPDATE OF state, not_before ON rhinoq_jobs
FOR EACH ROW EXECUTE FUNCTION rhinoq_notify_job_ready();
