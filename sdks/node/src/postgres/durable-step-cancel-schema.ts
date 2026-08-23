/** Adds fenced terminal cancellation for an already-running Durable Step. */
export const TASK_SCHEMA_V21_NAME = '021_durable_step_cancellation';

export const TASK_SCHEMA_V21_SQL = String.raw`
CREATE OR REPLACE FUNCTION rhinoq_task.cancel_durable_step(
  p_step_id text,
  p_attempt_id text,
  p_lease_owner text,
  p_lease_epoch bigint,
  p_reason text DEFAULT NULL
)
RETURNS rhinoq_task.durable_steps
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_step rhinoq_task.durable_steps%ROWTYPE;
  v_attempt rhinoq_task.durable_step_attempts%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_reason text := left(COALESCE(NULLIF(btrim(p_reason), ''), 'Task cancelled by user.'), 2048);
BEGIN
  IF btrim(COALESCE(p_step_id, '')) = '' OR btrim(COALESCE(p_attempt_id, '')) = ''
     OR btrim(COALESCE(p_lease_owner, '')) = '' OR p_lease_epoch IS NULL OR p_lease_epoch < 1 THEN
    PERFORM rhinoq_task.fail('RHINOQ_INVALID_DURABLE_STEP_CANCELLATION');
  END IF;
  SELECT * INTO v_step FROM rhinoq_task.durable_steps WHERE durable_steps.id = p_step_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM rhinoq_task.fail('RHINOQ_DURABLE_STEP_NOT_FOUND', p_step_id); END IF;
  SELECT * INTO v_attempt FROM rhinoq_task.durable_step_attempts
  WHERE durable_step_attempts.id = p_attempt_id AND durable_step_attempts.step_id = p_step_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM rhinoq_task.fail('RHINOQ_DURABLE_STEP_ATTEMPT_NOT_FOUND', p_attempt_id); END IF;
  IF v_step.state = 'cancelled' AND v_attempt.state = 'cancelled'
     AND v_attempt.lease_owner = btrim(p_lease_owner) AND v_attempt.lease_epoch = p_lease_epoch THEN
    RETURN v_step;
  END IF;
  IF v_step.state <> 'running' OR v_attempt.state <> 'running'
     OR v_attempt.lease_owner <> btrim(p_lease_owner)
     OR v_attempt.lease_epoch <> p_lease_epoch
     OR v_attempt.lease_until < v_now THEN
    PERFORM rhinoq_task.fail('RHINOQ_DURABLE_STEP_LEASE_FENCED', p_step_id);
  END IF;
  UPDATE rhinoq_task.durable_step_attempts
  SET state = 'cancelled', failure_reason = v_reason, updated_at = v_now, completed_at = v_now
  WHERE id = v_attempt.id;
  UPDATE rhinoq_task.durable_steps
  SET state = 'cancelled', failure_reason = v_reason, version = version + 1,
      updated_at = v_now, completed_at = v_now
  WHERE id = v_step.id
  RETURNING * INTO v_step;
  UPDATE rhinoq_task.tasks
  SET version = version + 1, updated_at = v_now
  WHERE tasks.id = v_step.task_id;
  RETURN v_step;
END;
$fn$;
`;
