/**
 * Durable Steps are an additive extension of the Task-only profile.  A
 * checkpoint remains a caller-owned cursor; a durable step owns its own
 * attempt/lease/result lifecycle and is therefore safe to resume after a
 * worker crashes.
 */
export const TASK_SCHEMA_V19_NAME = '019_durable_steps';

export const TASK_SCHEMA_V19_SQL = String.raw`
CREATE TABLE IF NOT EXISTS rhinoq_task.durable_steps (
  id text PRIMARY KEY CHECK (btrim(id) <> ''),
  tenant_id text NOT NULL CHECK (btrim(tenant_id) <> ''),
  task_id text NOT NULL,
  execution_id text NOT NULL,
  item_key text NOT NULL CHECK (btrim(item_key) <> '' AND length(item_key) <= 256),
  step_key text NOT NULL CHECK (btrim(step_key) <> '' AND length(step_key) <= 256),
  task_version integer NOT NULL CHECK (task_version > 0),
  step_version integer NOT NULL CHECK (step_version > 0),
  state text NOT NULL CHECK (state IN ('pending','running','completed','failed','cancelled')),
  result jsonb,
  UNIQUE (id, tenant_id),
  result_ref text,
  failure_reason text CHECK (length(COALESCE(failure_reason, '')) <= 2048),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (task_id, item_key, step_key),
  FOREIGN KEY (task_id, tenant_id) REFERENCES rhinoq_task.tasks(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (execution_id, tenant_id) REFERENCES rhinoq_task.executions(id, tenant_id) ON DELETE CASCADE,
  CHECK (result IS NULL OR octet_length(result::text) <= 65536),
  CHECK (state <> 'completed' OR result IS NOT NULL OR result_ref IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS durable_steps_task_item_idx
  ON rhinoq_task.durable_steps(task_id, item_key, created_at, id);
CREATE INDEX IF NOT EXISTS durable_steps_recovery_idx
  ON rhinoq_task.durable_steps(state, updated_at, id)
  WHERE state IN ('running','failed');

CREATE TABLE IF NOT EXISTS rhinoq_task.durable_step_attempts (
  id text PRIMARY KEY CHECK (btrim(id) <> ''),
  tenant_id text NOT NULL CHECK (btrim(tenant_id) <> ''),
  step_id text NOT NULL,
  execution_id text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  state text NOT NULL CHECK (state IN ('running','completed','failed','cancelled','expired')),
  lease_owner text NOT NULL CHECK (btrim(lease_owner) <> ''),
  lease_epoch bigint NOT NULL CHECK (lease_epoch > 0),
  lease_until timestamptz NOT NULL,
  failure_reason text CHECK (length(COALESCE(failure_reason, '')) <= 2048),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (step_id, attempt),
  FOREIGN KEY (step_id, tenant_id) REFERENCES rhinoq_task.durable_steps(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (execution_id, tenant_id) REFERENCES rhinoq_task.executions(id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS durable_step_attempts_active_idx
  ON rhinoq_task.durable_step_attempts(step_id, state, lease_until DESC, attempt DESC);

CREATE OR REPLACE FUNCTION rhinoq_task.acquire_durable_step(
  p_id text,
  p_task_id text,
  p_execution_id text,
  p_item_key text,
  p_task_version integer,
  p_step_key text,
  p_step_version integer,
  p_lease_owner text,
  p_lease_ms integer,
  p_max_attempts integer
)
RETURNS TABLE(
  action text,
  id text,
  task_id text,
  execution_id text,
  item_key text,
  step_key text,
  task_version integer,
  step_version integer,
  state text,
  result jsonb,
  result_ref text,
  failure_reason text,
  attempt integer,
  version bigint,
  created_at timestamptz,
  updated_at timestamptz,
  completed_at timestamptz,
  attempt_id text,
  lease_owner text,
  lease_epoch bigint,
  lease_until timestamptz
)
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_task rhinoq_task.tasks%ROWTYPE;
  v_execution rhinoq_task.executions%ROWTYPE;
  v_step rhinoq_task.durable_steps%ROWTYPE;
  v_previous rhinoq_task.durable_step_attempts%ROWTYPE;
  v_attempt rhinoq_task.durable_step_attempts%ROWTYPE;
  v_item_key text := btrim(COALESCE(p_item_key, 'default'));
  v_step_key text := btrim(COALESCE(p_step_key, ''));
  v_now timestamptz := clock_timestamp();
  v_next_attempt integer;
  v_attempt_id text;
BEGIN
  IF btrim(COALESCE(p_id, '')) = '' OR btrim(COALESCE(p_task_id, '')) = ''
     OR btrim(COALESCE(p_execution_id, '')) = '' OR v_item_key = '' OR v_step_key = ''
     OR length(v_item_key) > 256 OR length(v_step_key) > 256
     OR p_task_version IS NULL OR p_task_version < 1
     OR p_step_version IS NULL OR p_step_version < 1
     OR btrim(COALESCE(p_lease_owner, '')) = ''
     OR p_lease_ms IS NULL OR p_lease_ms < 1000 OR p_lease_ms > 3600000
     OR p_max_attempts IS NULL OR p_max_attempts < 1 OR p_max_attempts > 100 THEN
    PERFORM rhinoq_task.fail('RHINOQ_INVALID_DURABLE_STEP');
  END IF;

  SELECT * INTO v_task FROM rhinoq_task.tasks WHERE tasks.id = p_task_id;
  IF NOT FOUND THEN PERFORM rhinoq_task.fail('RHINOQ_TASK_NOT_FOUND', p_task_id); END IF;
  IF v_task.definition_version <> p_task_version THEN
    PERFORM rhinoq_task.fail('RHINOQ_DURABLE_STEP_TASK_VERSION_MISMATCH',
      format('Task definition is version %s; worker declared version %s.', v_task.definition_version, p_task_version));
  END IF;
  SELECT * INTO v_execution FROM rhinoq_task.executions
  WHERE executions.id = p_execution_id AND executions.task_id = p_task_id;
  IF NOT FOUND OR v_execution.item_key <> v_item_key OR v_execution.tenant_id <> v_task.tenant_id THEN
    PERFORM rhinoq_task.fail('RHINOQ_DURABLE_STEP_EXECUTION_MISMATCH');
  END IF;

  SELECT * INTO v_step FROM rhinoq_task.durable_steps
  WHERE durable_steps.task_id = p_task_id
    AND durable_steps.item_key = v_item_key
    AND durable_steps.step_key = v_step_key
  FOR UPDATE;

  IF NOT FOUND THEN
    v_next_attempt := 1;
    v_attempt_id := p_id || ':attempt:' || v_next_attempt::text;
    INSERT INTO rhinoq_task.durable_steps(
      id, tenant_id, task_id, execution_id, item_key, step_key, task_version,
      step_version, state, attempt
    ) VALUES (
      p_id, v_task.tenant_id, p_task_id, p_execution_id, v_item_key, v_step_key,
      p_task_version, p_step_version, 'running', v_next_attempt
    ) RETURNING * INTO v_step;
    INSERT INTO rhinoq_task.durable_step_attempts(
      id, tenant_id, step_id, execution_id, attempt, state, lease_owner,
      lease_epoch, lease_until
    ) VALUES (
      v_attempt_id, v_task.tenant_id, v_step.id, p_execution_id, v_next_attempt,
      'running', btrim(p_lease_owner), 1,
      v_now + make_interval(secs => p_lease_ms::double precision / 1000.0)
    ) RETURNING * INTO v_attempt;
  ELSE
    IF v_step.task_version <> p_task_version OR v_step.step_version <> p_step_version THEN
      PERFORM rhinoq_task.fail('RHINOQ_DURABLE_STEP_VERSION_MISMATCH',
        format('Step %s is stored as task version %s, step version %s; worker declared task version %s, step version %s.',
          v_step_key, v_step.task_version, v_step.step_version, p_task_version, p_step_version));
    END IF;
    IF v_step.state = 'completed' THEN
      RETURN QUERY SELECT
        'reused', v_step.id, v_step.task_id, v_step.execution_id, v_step.item_key,
        v_step.step_key, v_step.task_version, v_step.step_version, v_step.state,
        v_step.result, v_step.result_ref, v_step.failure_reason, v_step.attempt,
        v_step.version, v_step.created_at, v_step.updated_at, v_step.completed_at,
        NULL::text, NULL::text, NULL::bigint, NULL::timestamptz;
      RETURN;
    END IF;
    IF v_step.state = 'cancelled' THEN
      PERFORM rhinoq_task.fail('RHINOQ_DURABLE_STEP_CANCELLED', v_step_key);
    END IF;
    SELECT * INTO v_previous FROM rhinoq_task.durable_step_attempts
    WHERE durable_step_attempts.step_id = v_step.id
    ORDER BY durable_step_attempts.attempt DESC
    LIMIT 1 FOR UPDATE;
    IF FOUND AND v_previous.state = 'running' AND v_previous.lease_until > v_now THEN
      PERFORM rhinoq_task.fail('RHINOQ_DURABLE_STEP_LEASE_HELD',
        format('Step %s is leased by %s until %s.', v_step_key, v_previous.lease_owner, v_previous.lease_until));
    END IF;
    IF v_step.attempt >= p_max_attempts THEN
      PERFORM rhinoq_task.fail('RHINOQ_DURABLE_STEP_RETRY_EXHAUSTED',
        format('Step %s used %s of %s allowed attempts.', v_step_key, v_step.attempt, p_max_attempts));
    END IF;
    IF FOUND AND v_previous.state = 'running' THEN
      UPDATE rhinoq_task.durable_step_attempts
      SET state = 'expired', updated_at = v_now, completed_at = v_now
      WHERE id = v_previous.id;
    END IF;
    v_next_attempt := v_step.attempt + 1;
    v_attempt_id := v_step.id || ':attempt:' || v_next_attempt::text;
    UPDATE rhinoq_task.durable_steps
    SET execution_id = p_execution_id,
        state = 'running',
        failure_reason = NULL,
        attempt = v_next_attempt,
        version = version + 1,
        updated_at = v_now,
        completed_at = NULL
    WHERE id = v_step.id
    RETURNING * INTO v_step;
    INSERT INTO rhinoq_task.durable_step_attempts(
      id, tenant_id, step_id, execution_id, attempt, state, lease_owner,
      lease_epoch, lease_until
    ) VALUES (
      v_attempt_id, v_task.tenant_id, v_step.id, p_execution_id, v_next_attempt,
      'running', btrim(p_lease_owner), COALESCE(v_previous.lease_epoch, 0) + 1,
      v_now + make_interval(secs => p_lease_ms::double precision / 1000.0)
    ) RETURNING * INTO v_attempt;
  END IF;

  UPDATE rhinoq_task.tasks
  SET version = version + 1, updated_at = v_now
  WHERE tasks.id = p_task_id;
  RETURN QUERY SELECT
    'acquired', v_step.id, v_step.task_id, v_step.execution_id, v_step.item_key,
    v_step.step_key, v_step.task_version, v_step.step_version, v_step.state,
    v_step.result, v_step.result_ref, v_step.failure_reason, v_step.attempt,
    v_step.version, v_step.created_at, v_step.updated_at, v_step.completed_at,
    v_attempt.id, v_attempt.lease_owner, v_attempt.lease_epoch, v_attempt.lease_until;
EXCEPTION
  WHEN unique_violation THEN
    PERFORM rhinoq_task.fail('RHINOQ_DURABLE_STEP_ID_CONFLICT', p_id);
    RETURN;
END;
$fn$;

CREATE OR REPLACE FUNCTION rhinoq_task.renew_durable_step(
  p_step_id text,
  p_attempt_id text,
  p_lease_owner text,
  p_lease_epoch bigint,
  p_lease_ms integer
)
RETURNS TABLE(
  attempt_id text,
  lease_owner text,
  lease_epoch bigint,
  lease_until timestamptz
)
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_step rhinoq_task.durable_steps%ROWTYPE;
  v_attempt rhinoq_task.durable_step_attempts%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF btrim(COALESCE(p_step_id, '')) = '' OR btrim(COALESCE(p_attempt_id, '')) = ''
     OR btrim(COALESCE(p_lease_owner, '')) = '' OR p_lease_epoch IS NULL OR p_lease_epoch < 1
     OR p_lease_ms IS NULL OR p_lease_ms < 1000 OR p_lease_ms > 3600000 THEN
    PERFORM rhinoq_task.fail('RHINOQ_INVALID_DURABLE_STEP_RENEWAL');
  END IF;
  SELECT * INTO v_step FROM rhinoq_task.durable_steps WHERE durable_steps.id = p_step_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM rhinoq_task.fail('RHINOQ_DURABLE_STEP_NOT_FOUND', p_step_id); END IF;
  SELECT * INTO v_attempt FROM rhinoq_task.durable_step_attempts
  WHERE durable_step_attempts.id = p_attempt_id AND durable_step_attempts.step_id = p_step_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM rhinoq_task.fail('RHINOQ_DURABLE_STEP_ATTEMPT_NOT_FOUND', p_attempt_id); END IF;
  IF v_step.state <> 'running' OR v_attempt.state <> 'running'
     OR v_attempt.lease_owner <> btrim(p_lease_owner)
     OR v_attempt.lease_epoch <> p_lease_epoch
     OR v_attempt.lease_until <= v_now THEN
    PERFORM rhinoq_task.fail('RHINOQ_DURABLE_STEP_LEASE_FENCED', p_step_id);
  END IF;
  UPDATE rhinoq_task.durable_step_attempts
  SET lease_until = v_now + make_interval(secs => p_lease_ms::double precision / 1000.0),
      updated_at = v_now
  WHERE id = v_attempt.id
  RETURNING * INTO v_attempt;
  RETURN QUERY SELECT v_attempt.id, v_attempt.lease_owner, v_attempt.lease_epoch, v_attempt.lease_until;
END;
$fn$;

CREATE OR REPLACE FUNCTION rhinoq_task.complete_durable_step(
  p_step_id text,
  p_attempt_id text,
  p_lease_owner text,
  p_lease_epoch bigint,
  p_result jsonb,
  p_result_ref text DEFAULT NULL
)
RETURNS rhinoq_task.durable_steps
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_step rhinoq_task.durable_steps%ROWTYPE;
  v_attempt rhinoq_task.durable_step_attempts%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF btrim(COALESCE(p_step_id, '')) = '' OR btrim(COALESCE(p_attempt_id, '')) = ''
     OR btrim(COALESCE(p_lease_owner, '')) = '' OR p_lease_epoch IS NULL OR p_lease_epoch < 1
     OR p_result IS NULL OR octet_length(p_result::text) > 65536
     OR length(COALESCE(p_result_ref, '')) > 2048 THEN
    PERFORM rhinoq_task.fail('RHINOQ_INVALID_DURABLE_STEP_COMPLETION');
  END IF;
  SELECT * INTO v_step FROM rhinoq_task.durable_steps WHERE durable_steps.id = p_step_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM rhinoq_task.fail('RHINOQ_DURABLE_STEP_NOT_FOUND', p_step_id); END IF;
  SELECT * INTO v_attempt FROM rhinoq_task.durable_step_attempts
  WHERE durable_step_attempts.id = p_attempt_id AND durable_step_attempts.step_id = p_step_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM rhinoq_task.fail('RHINOQ_DURABLE_STEP_ATTEMPT_NOT_FOUND', p_attempt_id); END IF;
  IF v_step.state = 'completed' AND v_attempt.state = 'completed'
     AND v_attempt.lease_owner = btrim(p_lease_owner) AND v_attempt.lease_epoch = p_lease_epoch
     AND v_step.result IS NOT DISTINCT FROM p_result AND v_step.result_ref IS NOT DISTINCT FROM NULLIF(btrim(p_result_ref), '') THEN
    RETURN v_step;
  END IF;
  IF v_step.state <> 'running' OR v_attempt.state <> 'running'
     OR v_attempt.lease_owner <> btrim(p_lease_owner)
     OR v_attempt.lease_epoch <> p_lease_epoch
     OR v_attempt.lease_until < v_now THEN
    PERFORM rhinoq_task.fail('RHINOQ_DURABLE_STEP_LEASE_FENCED', p_step_id);
  END IF;
  UPDATE rhinoq_task.durable_step_attempts
  SET state = 'completed', updated_at = v_now, completed_at = v_now
  WHERE id = v_attempt.id;
  UPDATE rhinoq_task.durable_steps
  SET state = 'completed', result = p_result, result_ref = NULLIF(btrim(p_result_ref), ''),
      failure_reason = NULL, version = version + 1, updated_at = v_now, completed_at = v_now
  WHERE id = v_step.id
  RETURNING * INTO v_step;
  UPDATE rhinoq_task.tasks
  SET version = version + 1, updated_at = v_now
  WHERE tasks.id = v_step.task_id;
  RETURN v_step;
END;
$fn$;

CREATE OR REPLACE FUNCTION rhinoq_task.fail_durable_step(
  p_step_id text,
  p_attempt_id text,
  p_lease_owner text,
  p_lease_epoch bigint,
  p_reason text
)
RETURNS rhinoq_task.durable_steps
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_step rhinoq_task.durable_steps%ROWTYPE;
  v_attempt rhinoq_task.durable_step_attempts%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_reason text := left(COALESCE(NULLIF(btrim(p_reason), ''), 'Step handler failed.'), 2048);
BEGIN
  IF btrim(COALESCE(p_step_id, '')) = '' OR btrim(COALESCE(p_attempt_id, '')) = ''
     OR btrim(COALESCE(p_lease_owner, '')) = '' OR p_lease_epoch IS NULL OR p_lease_epoch < 1 THEN
    PERFORM rhinoq_task.fail('RHINOQ_INVALID_DURABLE_STEP_FAILURE');
  END IF;
  SELECT * INTO v_step FROM rhinoq_task.durable_steps WHERE durable_steps.id = p_step_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM rhinoq_task.fail('RHINOQ_DURABLE_STEP_NOT_FOUND', p_step_id); END IF;
  SELECT * INTO v_attempt FROM rhinoq_task.durable_step_attempts
  WHERE durable_step_attempts.id = p_attempt_id AND durable_step_attempts.step_id = p_step_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM rhinoq_task.fail('RHINOQ_DURABLE_STEP_ATTEMPT_NOT_FOUND', p_attempt_id); END IF;
  IF v_step.state IN ('completed','failed') AND v_attempt.state IN ('completed','failed')
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
  SET state = 'failed', failure_reason = v_reason, updated_at = v_now, completed_at = v_now
  WHERE id = v_attempt.id;
  UPDATE rhinoq_task.durable_steps
  SET state = 'failed', failure_reason = v_reason, version = version + 1, updated_at = v_now
  WHERE id = v_step.id
  RETURNING * INTO v_step;
  UPDATE rhinoq_task.tasks
  SET version = version + 1, updated_at = v_now
  WHERE tasks.id = v_step.task_id;
  RETURN v_step;
END;
$fn$;

ALTER TABLE rhinoq_task.durable_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE rhinoq_task.durable_steps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rhinoq_task_tenant_isolation ON rhinoq_task.durable_steps;
CREATE POLICY rhinoq_task_tenant_isolation ON rhinoq_task.durable_steps
  USING (tenant_id = rhinoq_task.current_tenant() OR rhinoq_task.maintenance_session())
  WITH CHECK (tenant_id = rhinoq_task.current_tenant() OR rhinoq_task.maintenance_session());

ALTER TABLE rhinoq_task.durable_step_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE rhinoq_task.durable_step_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rhinoq_task_tenant_isolation ON rhinoq_task.durable_step_attempts;
CREATE POLICY rhinoq_task_tenant_isolation ON rhinoq_task.durable_step_attempts
  USING (tenant_id = rhinoq_task.current_tenant() OR rhinoq_task.maintenance_session())
  WITH CHECK (tenant_id = rhinoq_task.current_tenant() OR rhinoq_task.maintenance_session());
`;
