import type { SqlExecutor } from './producer.js';

export const TASK_SCHEMA_VERSION = 7;
export const TASK_SCHEMA_NAME = '007_durable_waitpoints';

/**
 * Task-only PostgreSQL profile.
 *
 * It deliberately owns only its four tables in a dedicated schema:
 * migrations, tasks, executions and waitpoints. Runtime, Effect, Rule and Finding tables
 * belong to separate opt-in profiles.
 */
export const TASK_SCHEMA_SQL = String.raw`
CREATE SCHEMA IF NOT EXISTS rhinoq_task;

CREATE TABLE IF NOT EXISTS rhinoq_task.migrations (
  version integer PRIMARY KEY CHECK (version > 0),
  name text NOT NULL UNIQUE,
  checksum text NOT NULL CHECK (length(checksum) = 64),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS rhinoq_task.tasks (
  id text PRIMARY KEY,
  type text NOT NULL CHECK (btrim(type) <> ''),
  owner_id text,
  definition_version integer NOT NULL CHECK (definition_version > 0),
  state text NOT NULL CHECK (state IN (
    'pending', 'queued', 'running', 'succeeded', 'failed',
    'cancel_requested', 'cancelled'
  )),
  progress_completed bigint NOT NULL DEFAULT 0 CHECK (progress_completed >= 0),
  progress_total bigint CHECK (
    progress_total >= 0 AND progress_total >= progress_completed
  ),
  progress_message text,
  result_ref text,
  cancellation_status text NOT NULL DEFAULT 'none' CHECK (
    cancellation_status IN (
      'none', 'requested', 'acknowledged', 'cancelled',
      'too_late', 'cannot_cancel_safely', 'failed'
    )
  ),
  cancellation_reason text,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS tasks_owner_updated_idx
  ON rhinoq_task.tasks (owner_id, updated_at DESC, id)
  WHERE owner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_state_updated_idx
  ON rhinoq_task.tasks (state, updated_at, id);

CREATE TABLE IF NOT EXISTS rhinoq_task.executions (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES rhinoq_task.tasks(id) ON DELETE CASCADE,
  item_key text NOT NULL DEFAULT 'default' CHECK (btrim(item_key) <> ''),
  attempt integer NOT NULL CHECK (attempt > 0),
  runtime text NOT NULL CHECK (btrim(runtime) <> ''),
  runtime_scope text NOT NULL DEFAULT '',
  external_id text,
  state text NOT NULL CHECK (state IN (
    'pending_dispatch', 'dispatched', 'running', 'succeeded',
    'failed', 'stalled', 'cancelled'
  )),
  result_ref text,
  failure_reason text,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (task_id, item_key, attempt),
  CHECK (external_id IS NULL OR btrim(external_id) <> ''),
  CHECK (length(COALESCE(failure_reason, '')) <= 513)
);

CREATE UNIQUE INDEX IF NOT EXISTS executions_runtime_ref_unique
  ON rhinoq_task.executions (runtime, runtime_scope, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS executions_task_idx
  ON rhinoq_task.executions (task_id, item_key, attempt);

CREATE OR REPLACE FUNCTION rhinoq_task.fail(code text, detail text DEFAULT '')
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = code,
    DETAIL = NULLIF(detail, '');
END;
$$;

CREATE OR REPLACE FUNCTION rhinoq_task.create_task(
  p_id text,
  p_type text,
  p_owner_id text,
  p_definition_version integer
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_version bigint;
BEGIN
  IF btrim(COALESCE(p_id, '')) = '' OR btrim(COALESCE(p_type, '')) = ''
     OR p_definition_version <= 0 THEN
    PERFORM rhinoq_task.fail('RHINOQ_INVALID_TASK');
  END IF;
  INSERT INTO rhinoq_task.tasks (
    id, type, owner_id, definition_version, state
  ) VALUES (
    p_id, btrim(p_type), NULLIF(btrim(COALESCE(p_owner_id, '')), ''),
    p_definition_version, 'pending'
  )
  RETURNING version INTO v_version;
  RETURN v_version;
EXCEPTION
  WHEN unique_violation THEN
    PERFORM rhinoq_task.fail('RHINOQ_TASK_ALREADY_EXISTS', p_id);
    RETURN 0;
END;
$$;

CREATE OR REPLACE FUNCTION rhinoq_task.transition_task(
  p_id text,
  p_expected_version bigint,
  p_target text
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_task rhinoq_task.tasks%ROWTYPE;
BEGIN
  SELECT * INTO v_task FROM rhinoq_task.tasks WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM rhinoq_task.fail('RHINOQ_TASK_NOT_FOUND', p_id);
  END IF;
  IF v_task.version <> p_expected_version THEN
    PERFORM rhinoq_task.fail('RHINOQ_VERSION_CONFLICT', p_id);
  END IF;
  IF NOT (
    (v_task.state = 'pending' AND p_target = 'queued') OR
    (v_task.state = 'queued' AND p_target IN ('running', 'cancel_requested')) OR
    (v_task.state = 'running' AND p_target IN (
      'succeeded', 'failed', 'cancel_requested'
    )) OR
    (v_task.state = 'cancel_requested' AND p_target IN (
      'succeeded', 'failed', 'cancelled'
    )) OR
    (v_task.state IN ('failed', 'cancelled') AND p_target = 'queued')
  ) THEN
    PERFORM rhinoq_task.fail(
      'RHINOQ_INVALID_TASK_TRANSITION',
      v_task.state || ' -> ' || COALESCE(p_target, '')
    );
  END IF;

  UPDATE rhinoq_task.tasks
  SET state = p_target,
      cancellation_status = CASE
        WHEN p_target = 'queued' AND v_task.state IN ('failed', 'cancelled')
          THEN 'none'
        WHEN p_target = 'cancel_requested' AND cancellation_status = 'none'
          THEN 'requested'
        WHEN v_task.state = 'cancel_requested' AND p_target = 'cancelled'
          THEN 'cancelled'
        WHEN v_task.state = 'cancel_requested' AND p_target = 'succeeded'
          THEN 'too_late'
        WHEN v_task.state = 'cancel_requested' AND p_target = 'failed'
          THEN 'failed'
        ELSE cancellation_status
      END,
      cancellation_reason = CASE
        WHEN p_target = 'queued' AND v_task.state IN ('failed', 'cancelled')
          THEN NULL
        ELSE cancellation_reason
      END,
      version = version + 1,
      updated_at = clock_timestamp()
  WHERE id = p_id
  RETURNING version INTO v_task.version;
  RETURN v_task.version;
END;
$$;

CREATE OR REPLACE FUNCTION rhinoq_task.report_progress(
  p_id text,
  p_expected_version bigint,
  p_completed bigint,
  p_total bigint,
  p_has_total boolean,
  p_message text
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_task rhinoq_task.tasks%ROWTYPE;
  v_total bigint := CASE WHEN p_has_total THEN p_total ELSE NULL END;
  v_message text := NULLIF(COALESCE(p_message, ''), '');
BEGIN
  SELECT * INTO v_task FROM rhinoq_task.tasks WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM rhinoq_task.fail('RHINOQ_TASK_NOT_FOUND', p_id);
  END IF;
  IF v_task.state NOT IN ('running', 'cancel_requested') THEN
    PERFORM rhinoq_task.fail('RHINOQ_PROGRESS_STATE', v_task.state);
  END IF;
  IF p_completed < 0 OR (p_has_total AND (p_total < 0 OR p_total < p_completed)) THEN
    PERFORM rhinoq_task.fail('RHINOQ_INVALID_PROGRESS');
  END IF;

  -- A re-delivered observation is a no-op even with a stale fence.
  IF v_task.progress_completed = p_completed
     AND v_task.progress_total IS NOT DISTINCT FROM v_total
     AND v_task.progress_message IS NOT DISTINCT FROM v_message THEN
    RETURN v_task.version;
  END IF;
  IF v_task.version <> p_expected_version THEN
    PERFORM rhinoq_task.fail('RHINOQ_VERSION_CONFLICT', p_id);
  END IF;
  IF p_completed < v_task.progress_completed THEN
    PERFORM rhinoq_task.fail('RHINOQ_PROGRESS_REGRESSION', p_id);
  END IF;
  IF v_task.progress_total IS NOT NULL
     AND v_task.progress_total IS DISTINCT FROM v_total THEN
    PERFORM rhinoq_task.fail('RHINOQ_PROGRESS_TOTAL_CHANGED', p_id);
  END IF;

  UPDATE rhinoq_task.tasks
  SET progress_completed = p_completed,
      progress_total = v_total,
      progress_message = v_message,
      version = version + 1,
      updated_at = clock_timestamp()
  WHERE id = p_id
  RETURNING version INTO v_task.version;
  RETURN v_task.version;
END;
$$;

CREATE OR REPLACE FUNCTION rhinoq_task.request_cancellation(
  p_id text,
  p_expected_version bigint
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_task rhinoq_task.tasks%ROWTYPE;
BEGIN
  SELECT * INTO v_task FROM rhinoq_task.tasks WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM rhinoq_task.fail('RHINOQ_TASK_NOT_FOUND', p_id);
  END IF;
  IF v_task.state = 'cancel_requested' THEN
    RETURN v_task.version;
  END IF;
  IF v_task.version <> p_expected_version THEN
    PERFORM rhinoq_task.fail('RHINOQ_VERSION_CONFLICT', p_id);
  END IF;
  IF v_task.state NOT IN ('queued', 'running') THEN
    PERFORM rhinoq_task.fail('RHINOQ_INVALID_TASK_TRANSITION', v_task.state);
  END IF;
  UPDATE rhinoq_task.tasks
  SET state = 'cancel_requested',
      cancellation_status = 'requested',
      version = version + 1,
      updated_at = clock_timestamp()
  WHERE id = p_id
  RETURNING version INTO v_task.version;
  RETURN v_task.version;
END;
$$;

CREATE OR REPLACE FUNCTION rhinoq_task.resolve_cancellation(
  p_id text,
  p_expected_version bigint,
  p_status text,
  p_reason text
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_task rhinoq_task.tasks%ROWTYPE;
BEGIN
  SELECT * INTO v_task FROM rhinoq_task.tasks WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM rhinoq_task.fail('RHINOQ_TASK_NOT_FOUND', p_id);
  END IF;
  IF v_task.version <> p_expected_version THEN
    PERFORM rhinoq_task.fail('RHINOQ_VERSION_CONFLICT', p_id);
  END IF;
  IF v_task.state <> 'cancel_requested'
     OR p_status NOT IN ('acknowledged', 'cannot_cancel_safely', 'failed') THEN
    PERFORM rhinoq_task.fail('RHINOQ_INVALID_CANCELLATION', p_status);
  END IF;
  UPDATE rhinoq_task.tasks
  SET cancellation_status = p_status,
      cancellation_reason = NULLIF(btrim(COALESCE(p_reason, '')), ''),
      version = version + 1,
      updated_at = clock_timestamp()
  WHERE id = p_id
  RETURNING version INTO v_task.version;
  RETURN v_task.version;
END;
$$;

CREATE OR REPLACE FUNCTION rhinoq_task.attach_task_result(
  p_id text,
  p_expected_version bigint,
  p_reference text
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_task rhinoq_task.tasks%ROWTYPE;
  v_reference text := btrim(COALESCE(p_reference, ''));
BEGIN
  SELECT * INTO v_task FROM rhinoq_task.tasks WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM rhinoq_task.fail('RHINOQ_TASK_NOT_FOUND', p_id);
  END IF;
  IF v_reference = '' THEN
    PERFORM rhinoq_task.fail('RHINOQ_INVALID_RESULT');
  END IF;
  IF v_task.result_ref = v_reference THEN
    RETURN v_task.version;
  END IF;
  IF v_task.version <> p_expected_version THEN
    PERFORM rhinoq_task.fail('RHINOQ_VERSION_CONFLICT', p_id);
  END IF;
  UPDATE rhinoq_task.tasks
  SET result_ref = v_reference,
      version = version + 1,
      updated_at = clock_timestamp()
  WHERE id = p_id
  RETURNING version INTO v_task.version;
  RETURN v_task.version;
END;
$$;

CREATE OR REPLACE FUNCTION rhinoq_task.create_execution(
  p_id text,
  p_task_id text,
  p_item_key text,
  p_runtime text,
  p_runtime_scope text,
  p_external_id text
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_item_key text := btrim(COALESCE(p_item_key, 'default'));
  v_attempt integer;
BEGIN
  IF btrim(COALESCE(p_id, '')) = '' OR btrim(COALESCE(p_runtime, '')) = ''
     OR v_item_key = '' THEN
    PERFORM rhinoq_task.fail('RHINOQ_INVALID_EXECUTION');
  END IF;
  PERFORM 1 FROM rhinoq_task.tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM rhinoq_task.fail('RHINOQ_TASK_NOT_FOUND', p_task_id);
  END IF;
  SELECT COALESCE(MAX(attempt), 0) + 1 INTO v_attempt
  FROM rhinoq_task.executions
  WHERE task_id = p_task_id AND item_key = v_item_key;

  INSERT INTO rhinoq_task.executions (
    id, task_id, item_key, attempt, runtime, runtime_scope,
    external_id, state
  ) VALUES (
    p_id, p_task_id, v_item_key, v_attempt, btrim(p_runtime),
    btrim(COALESCE(p_runtime_scope, '')),
    NULLIF(btrim(COALESCE(p_external_id, '')), ''), 'pending_dispatch'
  );
  UPDATE rhinoq_task.tasks
  SET version = version + 1, updated_at = clock_timestamp()
  WHERE id = p_task_id;
  RETURN v_attempt;
EXCEPTION
  WHEN unique_violation THEN
    PERFORM rhinoq_task.fail('RHINOQ_EXECUTION_ALREADY_EXISTS', p_id);
    RETURN 0;
END;
$$;

CREATE OR REPLACE FUNCTION rhinoq_task.bind_execution(
  p_id text,
  p_expected_version bigint,
  p_runtime text,
  p_runtime_scope text,
  p_external_id text
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_execution rhinoq_task.executions%ROWTYPE;
BEGIN
  SELECT * INTO v_execution
  FROM rhinoq_task.executions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM rhinoq_task.fail('RHINOQ_EXECUTION_NOT_FOUND', p_id);
  END IF;
  IF v_execution.version <> p_expected_version THEN
    PERFORM rhinoq_task.fail('RHINOQ_VERSION_CONFLICT', p_id);
  END IF;
  IF v_execution.state <> 'pending_dispatch'
     OR v_execution.runtime <> btrim(COALESCE(p_runtime, '')) THEN
    PERFORM rhinoq_task.fail('RHINOQ_INVALID_EXECUTION_BINDING', p_id);
  END IF;
  IF v_execution.external_id IS NOT NULL
     AND (
       v_execution.external_id <> btrim(COALESCE(p_external_id, '')) OR
       v_execution.runtime_scope <> btrim(COALESCE(p_runtime_scope, ''))
     ) THEN
    PERFORM rhinoq_task.fail('RHINOQ_EXECUTION_ALREADY_BOUND', p_id);
  END IF;
  IF btrim(COALESCE(p_external_id, '')) = '' THEN
    PERFORM rhinoq_task.fail('RHINOQ_INVALID_EXECUTION_BINDING', p_id);
  END IF;

  UPDATE rhinoq_task.executions
  SET runtime_scope = btrim(COALESCE(p_runtime_scope, '')),
      external_id = btrim(p_external_id),
      state = 'dispatched',
      version = version + 1,
      updated_at = clock_timestamp()
  WHERE id = p_id
  RETURNING version INTO v_execution.version;
  UPDATE rhinoq_task.tasks
  SET version = version + 1, updated_at = clock_timestamp()
  WHERE id = v_execution.task_id;
  RETURN v_execution.version;
END;
$$;

CREATE OR REPLACE FUNCTION rhinoq_task.transition_execution(
  p_id text,
  p_expected_version bigint,
  p_target text,
  p_reason text
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_execution rhinoq_task.executions%ROWTYPE;
BEGIN
  SELECT * INTO v_execution
  FROM rhinoq_task.executions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM rhinoq_task.fail('RHINOQ_EXECUTION_NOT_FOUND', p_id);
  END IF;
  IF v_execution.state = p_target THEN
    RETURN v_execution.version;
  END IF;
  IF v_execution.version <> p_expected_version THEN
    PERFORM rhinoq_task.fail('RHINOQ_VERSION_CONFLICT', p_id);
  END IF;
  IF NOT (
    (v_execution.state = 'pending_dispatch' AND p_target = 'cancelled') OR
    (v_execution.state = 'dispatched' AND p_target IN ('running', 'cancelled')) OR
    (v_execution.state = 'running' AND p_target IN (
      'succeeded', 'failed', 'stalled', 'cancelled'
    )) OR
    (v_execution.state = 'stalled' AND p_target IN (
      'dispatched', 'failed', 'cancelled'
    ))
  ) THEN
    PERFORM rhinoq_task.fail(
      'RHINOQ_INVALID_EXECUTION_TRANSITION',
      v_execution.state || ' -> ' || COALESCE(p_target, '')
    );
  END IF;
  UPDATE rhinoq_task.executions
  SET state = p_target,
      failure_reason = CASE
        WHEN p_target = 'failed'
          THEN left(NULLIF(btrim(COALESCE(p_reason, '')), ''), 512)
        ELSE failure_reason
      END,
      version = version + 1,
      updated_at = clock_timestamp()
  WHERE id = p_id
  RETURNING version INTO v_execution.version;
  UPDATE rhinoq_task.tasks
  SET version = version + 1, updated_at = clock_timestamp()
  WHERE id = v_execution.task_id;
  RETURN v_execution.version;
END;
$$;

CREATE OR REPLACE FUNCTION rhinoq_task.attach_execution_result(
  p_id text,
  p_expected_version bigint,
  p_reference text
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_execution rhinoq_task.executions%ROWTYPE;
  v_reference text := btrim(COALESCE(p_reference, ''));
BEGIN
  SELECT * INTO v_execution
  FROM rhinoq_task.executions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM rhinoq_task.fail('RHINOQ_EXECUTION_NOT_FOUND', p_id);
  END IF;
  IF v_reference = '' THEN
    PERFORM rhinoq_task.fail('RHINOQ_INVALID_RESULT');
  END IF;
  IF v_execution.result_ref = v_reference THEN
    RETURN v_execution.version;
  END IF;
  IF v_execution.version <> p_expected_version THEN
    PERFORM rhinoq_task.fail('RHINOQ_VERSION_CONFLICT', p_id);
  END IF;
  UPDATE rhinoq_task.executions
  SET result_ref = v_reference,
      version = version + 1,
      updated_at = clock_timestamp()
  WHERE id = p_id
  RETURNING version INTO v_execution.version;
  UPDATE rhinoq_task.tasks
  SET version = version + 1, updated_at = clock_timestamp()
  WHERE id = v_execution.task_id;
  RETURN v_execution.version;
END;
$$;
`;

export const TASK_SCHEMA_V2_SQL = String.raw`
ALTER TABLE rhinoq_task.tasks
  DROP CONSTRAINT IF EXISTS tasks_state_check;
ALTER TABLE rhinoq_task.tasks
  ADD CONSTRAINT tasks_state_check CHECK (state IN (
    'pending', 'queued', 'running', 'uncertain', 'succeeded', 'failed',
    'cancel_requested', 'cancelled'
  ));

ALTER TABLE rhinoq_task.tasks
  ADD COLUMN IF NOT EXISTS execution_total bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS execution_pending_dispatch bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS execution_dispatched bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS execution_running bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS execution_succeeded bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS execution_failed bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS execution_stalled bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS execution_cancelled bigint NOT NULL DEFAULT 0;

WITH counts AS (
  SELECT task_id, count(*) AS total,
    count(*) FILTER (WHERE state='pending_dispatch') AS pending_dispatch,
    count(*) FILTER (WHERE state='dispatched') AS dispatched,
    count(*) FILTER (WHERE state='running') AS running,
    count(*) FILTER (WHERE state='succeeded') AS succeeded,
    count(*) FILTER (WHERE state='failed') AS failed,
    count(*) FILTER (WHERE state='stalled') AS stalled,
    count(*) FILTER (WHERE state='cancelled') AS cancelled
  FROM rhinoq_task.executions GROUP BY task_id
)
UPDATE rhinoq_task.tasks AS task SET
  execution_total=counts.total,
  execution_pending_dispatch=counts.pending_dispatch,
  execution_dispatched=counts.dispatched,
  execution_running=counts.running,
  execution_succeeded=counts.succeeded,
  execution_failed=counts.failed,
  execution_stalled=counts.stalled,
  execution_cancelled=counts.cancelled
FROM counts WHERE counts.task_id=task.id;

CREATE OR REPLACE FUNCTION rhinoq_task.update_execution_counts()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_task_id text := COALESCE(NEW.task_id, OLD.task_id);
  v_old text := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN OLD.state ELSE NULL END;
  v_new text := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN NEW.state ELSE NULL END;
  v_total_delta bigint := CASE TG_OP WHEN 'INSERT' THEN 1 WHEN 'DELETE' THEN -1 ELSE 0 END;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.state = NEW.state THEN
    RETURN NEW;
  END IF;
  UPDATE rhinoq_task.tasks SET
    execution_total=execution_total+v_total_delta,
    execution_pending_dispatch=execution_pending_dispatch+(CASE WHEN v_old='pending_dispatch' THEN -1 ELSE 0 END)+(CASE WHEN v_new='pending_dispatch' THEN 1 ELSE 0 END),
    execution_dispatched=execution_dispatched+(CASE WHEN v_old='dispatched' THEN -1 ELSE 0 END)+(CASE WHEN v_new='dispatched' THEN 1 ELSE 0 END),
    execution_running=execution_running+(CASE WHEN v_old='running' THEN -1 ELSE 0 END)+(CASE WHEN v_new='running' THEN 1 ELSE 0 END),
    execution_succeeded=execution_succeeded+(CASE WHEN v_old='succeeded' THEN -1 ELSE 0 END)+(CASE WHEN v_new='succeeded' THEN 1 ELSE 0 END),
    execution_failed=execution_failed+(CASE WHEN v_old='failed' THEN -1 ELSE 0 END)+(CASE WHEN v_new='failed' THEN 1 ELSE 0 END),
    execution_stalled=execution_stalled+(CASE WHEN v_old='stalled' THEN -1 ELSE 0 END)+(CASE WHEN v_new='stalled' THEN 1 ELSE 0 END),
    execution_cancelled=execution_cancelled+(CASE WHEN v_old='cancelled' THEN -1 ELSE 0 END)+(CASE WHEN v_new='cancelled' THEN 1 ELSE 0 END)
  WHERE id=v_task_id;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS executions_update_counts ON rhinoq_task.executions;
CREATE TRIGGER executions_update_counts
AFTER INSERT OR UPDATE OF state OR DELETE ON rhinoq_task.executions
FOR EACH ROW EXECUTE FUNCTION rhinoq_task.update_execution_counts();

CREATE OR REPLACE FUNCTION rhinoq_task.transition_task(
  p_id text, p_expected_version bigint, p_target text
)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_task rhinoq_task.tasks%ROWTYPE;
BEGIN
  SELECT * INTO v_task FROM rhinoq_task.tasks WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM rhinoq_task.fail('RHINOQ_TASK_NOT_FOUND', p_id); END IF;
  IF v_task.version <> p_expected_version THEN
    PERFORM rhinoq_task.fail('RHINOQ_VERSION_CONFLICT', p_id);
  END IF;
  IF NOT (
    (v_task.state='pending' AND p_target='queued') OR
    (v_task.state='queued' AND p_target IN ('running','cancel_requested')) OR
    (v_task.state='running' AND p_target IN ('uncertain','succeeded','failed','cancel_requested')) OR
    (v_task.state='uncertain' AND p_target IN ('succeeded','failed')) OR
    (v_task.state='cancel_requested' AND p_target IN ('uncertain','succeeded','failed','cancelled')) OR
    (v_task.state IN ('failed','cancelled') AND p_target='queued')
  ) THEN
    PERFORM rhinoq_task.fail('RHINOQ_INVALID_TASK_TRANSITION', v_task.state || ' -> ' || COALESCE(p_target,''));
  END IF;
  UPDATE rhinoq_task.tasks SET state=p_target,
    cancellation_status=CASE
      WHEN p_target='queued' AND v_task.state IN ('failed','cancelled') THEN 'none'
      WHEN p_target='cancel_requested' AND cancellation_status='none' THEN 'requested'
      WHEN v_task.state='cancel_requested' AND p_target='cancelled' THEN 'cancelled'
      WHEN v_task.state='cancel_requested' AND p_target='succeeded' THEN 'too_late'
      WHEN v_task.state='cancel_requested' AND p_target='failed' THEN 'failed'
      ELSE cancellation_status END,
    cancellation_reason=CASE
      WHEN p_target='queued' AND v_task.state IN ('failed','cancelled') THEN NULL
      ELSE cancellation_reason END,
    version=version+1, updated_at=clock_timestamp()
  WHERE id=p_id RETURNING version INTO v_task.version;
  RETURN v_task.version;
END;
$$;
`;

/**
 * Expand step for per-attempt history of an external runtime's retries.
 *
 * A BullMQ retry reuses its job ID. `executions_runtime_ref_unique` allowed
 * exactly one Execution per (runtime, scope, external id), so the retry had
 * nowhere to go: the first attempt was already terminal, its state machine
 * refused to move, and the second run left no record at all. The `attempt`
 * column existed and never advanced past 1 for any external runtime.
 *
 * This adds `superseded_at` and a partial unique index that only covers live
 * rows. It is purely additive: code that never sets `superseded_at` still sees
 * at most one live row per external ID, exactly as before, so a process running
 * the previous SDK against this schema behaves identically.
 *
 * The old index still forbids the second row. Dropping it is v4.
 */
export const TASK_SCHEMA_V3_SQL = String.raw`
ALTER TABLE rhinoq_task.executions
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS executions_runtime_ref_live_unique
  ON rhinoq_task.executions (runtime, runtime_scope, external_id)
  WHERE external_id IS NOT NULL AND superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS executions_item_attempt_idx
  ON rhinoq_task.executions (task_id, item_key, attempt DESC);
`;

/**
 * Contract step: the old index is what forbade the retry row, so it goes.
 *
 * Rollback is `CREATE UNIQUE INDEX executions_runtime_ref_unique ...` and it
 * only succeeds while no external ID has more than one row. Stop projecting
 * retries first -- set `retryProjection: 'ignore'` on the bridge, or stop the
 * bridge -- then roll back. Rolling back with superseded rows present fails
 * loudly on the index build, which is the correct place to find out.
 */
export const TASK_SCHEMA_V4_SQL = String.raw`
DROP INDEX IF EXISTS rhinoq_task.executions_runtime_ref_unique;

CREATE OR REPLACE FUNCTION rhinoq_task.retry_execution(
  p_id text,
  p_expected_version bigint,
  p_new_id text
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_execution rhinoq_task.executions%ROWTYPE;
  v_attempt integer;
BEGIN
  IF btrim(COALESCE(p_new_id, '')) = '' THEN
    PERFORM rhinoq_task.fail('RHINOQ_INVALID_EXECUTION');
  END IF;
  SELECT * INTO v_execution FROM rhinoq_task.executions
  WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM rhinoq_task.fail('RHINOQ_EXECUTION_NOT_FOUND', p_id);
  END IF;
  IF v_execution.superseded_at IS NOT NULL THEN
    PERFORM rhinoq_task.fail('RHINOQ_EXECUTION_SUPERSEDED', p_id);
  END IF;
  IF v_execution.version <> p_expected_version THEN
    PERFORM rhinoq_task.fail('RHINOQ_VERSION_CONFLICT', p_id);
  END IF;
  -- Only a finished attempt may be superseded. Superseding a running one
  -- would leave two live executions of the same item, which is the exact
  -- thing the fencing exists to prevent.
  IF v_execution.state NOT IN ('succeeded', 'failed', 'stalled', 'cancelled') THEN
    PERFORM rhinoq_task.fail('RHINOQ_INVALID_EXECUTION_TRANSITION',
      v_execution.state || ' -> superseded');
  END IF;

  UPDATE rhinoq_task.executions
  SET superseded_at = clock_timestamp(),
      version = version + 1,
      updated_at = clock_timestamp()
  WHERE id = p_id;

  SELECT COALESCE(MAX(attempt), 0) + 1 INTO v_attempt
  FROM rhinoq_task.executions
  WHERE task_id = v_execution.task_id AND item_key = v_execution.item_key;

  INSERT INTO rhinoq_task.executions (
    id, task_id, item_key, attempt, runtime, runtime_scope, external_id, state
  ) VALUES (
    p_new_id, v_execution.task_id, v_execution.item_key, v_attempt,
    v_execution.runtime, v_execution.runtime_scope, v_execution.external_id,
    'dispatched'
  );

  UPDATE rhinoq_task.tasks
  SET version = version + 1, updated_at = clock_timestamp()
  WHERE id = v_execution.task_id;
  RETURN v_attempt;
EXCEPTION
  WHEN unique_violation THEN
    PERFORM rhinoq_task.fail('RHINOQ_EXECUTION_ALREADY_EXISTS', p_new_id);
    RETURN 0;
END;
$$;
`;

/**
 * "Every item has finished", delivered once.
 *
 * A fan-out with `aggregate.progress: 'terminal-items'` writes progress on
 * every completion: fifty items, fifty round trips, and an application that
 * wants the single moment the batch became complete has to derive it by
 * counting. Every adopter wrote that counter, and every one of them wrote it
 * as "did I just see the last one?", which is wrong the moment two workers
 * finish concurrently or an event is re-delivered.
 *
 * `settle_items` answers it in one statement. The flag is set by exactly one
 * caller because the UPDATE filters on `items_settled_at IS NULL`; everyone
 * else gets false. Repeating the call is free and stays false.
 *
 * Superseded attempts cannot make this fire early: only a terminal attempt may
 * be superseded, so a superseded row never sits in a non-terminal counter.
 */
export const TASK_SCHEMA_V5_SQL = String.raw`
ALTER TABLE rhinoq_task.tasks
  ADD COLUMN IF NOT EXISTS items_settled_at timestamptz;

CREATE INDEX IF NOT EXISTS tasks_state_age_idx
  ON rhinoq_task.tasks (state, updated_at)
  INCLUDE (id, items_settled_at);

CREATE OR REPLACE FUNCTION rhinoq_task.settle_items(p_id text)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_settled boolean := false;
BEGIN
  -- version is deliberately not advanced. It is the optimistic-concurrency
  -- token every holder of a Snapshot is carrying, and items_settled_at is not
  -- in the Snapshot: bumping it would invalidate every caller's token for a
  -- change none of them can observe. On a fan-out that is a burst of version
  -- conflicts, at exactly the moment the last item lands, in return for
  -- nothing. updated_at still moves, which is what the reconciliation query
  -- reads.
  UPDATE rhinoq_task.tasks
  SET items_settled_at = clock_timestamp(),
      updated_at = clock_timestamp()
  WHERE id = p_id
    AND items_settled_at IS NULL
    AND execution_total > 0
    -- 'stalled' blocks: a stalled attempt is not a finished one, and calling
    -- the batch complete while one is stuck is the failure this replaces.
    AND execution_pending_dispatch + execution_dispatched
        + execution_running + execution_stalled = 0
  RETURNING true INTO v_settled;
  RETURN COALESCE(v_settled, false);
END;
$$;
`;

/**
 * Transactional application effect gate.
 *
 * An external BullMQ retry can run the same business handler again. This
 * command lets an application claim a named effect for one item inside the
 * same PostgreSQL transaction as its business write. The marker is kept on
 * the current Execution, while the lookup spans all attempts for the item,
 * so a retry sees the committed claim instead of running the write again.
 * It is deliberately not an external-provider exactly-once promise: those
 * calls still need ProviderOperation/idempotency/confirmation.
 */
export const TASK_SCHEMA_V6_SQL = String.raw`
ALTER TABLE rhinoq_task.executions
  ADD COLUMN IF NOT EXISTS effect_keys text[] NOT NULL DEFAULT ARRAY[]::text[];

ALTER TABLE rhinoq_task.executions
  DROP CONSTRAINT IF EXISTS executions_effect_keys_cardinality_check;
ALTER TABLE rhinoq_task.executions
  ADD CONSTRAINT executions_effect_keys_cardinality_check
  CHECK (cardinality(effect_keys) <= 256);

CREATE OR REPLACE FUNCTION rhinoq_task.claim_item_effect(
  p_execution_id text,
  p_effect_key text
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_task_id text;
  v_item_key text;
  v_current_id text;
  v_effect_key text := btrim(COALESCE(p_effect_key, ''));
BEGIN
  IF btrim(COALESCE(p_execution_id, '')) = ''
     OR v_effect_key = '' OR length(v_effect_key) > 256 THEN
    PERFORM rhinoq_task.fail('RHINOQ_INVALID_ITEM_EFFECT');
  END IF;

  SELECT task_id, item_key INTO v_task_id, v_item_key
  FROM rhinoq_task.executions
  WHERE id = p_execution_id
  FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM rhinoq_task.fail('RHINOQ_EXECUTION_NOT_FOUND', p_execution_id);
  END IF;

  -- Lock the parent before inspecting all attempts. Retry creation and this
  -- claim then serialize on the same Task row instead of racing a new item
  -- attempt into the middle of the scan.
  PERFORM 1 FROM rhinoq_task.tasks WHERE id = v_task_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM rhinoq_task.fail('RHINOQ_TASK_NOT_FOUND', v_task_id);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM rhinoq_task.executions
    WHERE task_id = v_task_id
      AND item_key = v_item_key
      AND v_effect_key = ANY(effect_keys)
  ) THEN
    RETURN false;
  END IF;

  SELECT id INTO v_current_id
  FROM rhinoq_task.executions
  WHERE task_id = v_task_id
    AND item_key = v_item_key
    AND superseded_at IS NULL
  ORDER BY attempt DESC, id DESC
  LIMIT 1
  FOR UPDATE;
  IF v_current_id IS NULL THEN
    PERFORM rhinoq_task.fail('RHINOQ_EXECUTION_NOT_FOUND', p_execution_id);
  END IF;

  UPDATE rhinoq_task.executions
  SET effect_keys = array_append(effect_keys, v_effect_key),
      version = version + 1,
      updated_at = clock_timestamp()
  WHERE id = v_current_id;
  UPDATE rhinoq_task.tasks
  SET version = version + 1, updated_at = clock_timestamp()
  WHERE id = v_task_id;
  RETURN true;
END;
$$;
`;

const TASK_SCHEMA_V7_SQL = String.raw`
CREATE TABLE IF NOT EXISTS rhinoq_task.waitpoints (
  id text PRIMARY KEY CHECK (btrim(id) <> ''),
  task_id text NOT NULL REFERENCES rhinoq_task.tasks(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (btrim(key) <> ''),
  kind text NOT NULL CHECK (kind IN ('input','approval','webhook')),
  payload_version integer NOT NULL CHECK (payload_version > 0),
  state text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting','resolved','expired','cancelled')),
  deadline timestamptz,
  resolution jsonb,
  resolution_hash text,
  resolution_id text,
  resolved_by text,
  resolved_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(task_id,key),
  CHECK (deadline IS NULL OR deadline > created_at),
  CHECK ((state='resolved' AND resolution IS NOT NULL AND resolution_hash IS NOT NULL AND resolution_id IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
    OR (state<>'resolved' AND resolution IS NULL AND resolution_hash IS NULL AND resolution_id IS NULL AND resolved_by IS NULL AND resolved_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS waitpoints_resolution_id_uq ON rhinoq_task.waitpoints(resolution_id) WHERE resolution_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS waitpoints_due_idx ON rhinoq_task.waitpoints(deadline,id) WHERE state='waiting' AND deadline IS NOT NULL;
CREATE INDEX IF NOT EXISTS waitpoints_task_idx ON rhinoq_task.waitpoints(task_id,created_at,id);

CREATE OR REPLACE FUNCTION rhinoq_task.create_waitpoint(p_id text,p_task_id text,p_key text,p_kind text,p_payload_version integer,p_deadline timestamptz)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v rhinoq_task.waitpoints%ROWTYPE;
BEGIN
  INSERT INTO rhinoq_task.waitpoints(id,task_id,key,kind,payload_version,deadline)
  VALUES(p_id,p_task_id,p_key,p_kind,p_payload_version,p_deadline)
  ON CONFLICT DO NOTHING;
  IF FOUND THEN
    UPDATE rhinoq_task.tasks SET version=version+1,updated_at=clock_timestamp() WHERE id=p_task_id;
    RETURN false;
  END IF;
  SELECT * INTO v FROM rhinoq_task.waitpoints WHERE task_id=p_task_id AND key=p_key;
  IF v.id IS NULL OR v.id<>p_id OR v.kind<>p_kind OR v.payload_version<>p_payload_version OR v.deadline IS DISTINCT FROM p_deadline THEN
    PERFORM rhinoq_task.fail('RHINOQ_WAITPOINT_CONFLICT',p_id);
  END IF;
  RETURN true;
END; $$;

CREATE OR REPLACE FUNCTION rhinoq_task.resolve_waitpoint(p_id text,p_owner_id text,p_expected_version bigint,p_resolution_id text,p_actor text,p_resolution jsonb,p_resolution_hash text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v rhinoq_task.waitpoints%ROWTYPE;
BEGIN
  SELECT w.* INTO v FROM rhinoq_task.waitpoints w JOIN rhinoq_task.tasks t ON t.id=w.task_id
  WHERE w.id=p_id AND t.owner_id=p_owner_id FOR UPDATE OF w;
  IF v.id IS NULL THEN PERFORM rhinoq_task.fail('RHINOQ_WAITPOINT_NOT_FOUND',p_id); END IF;
  IF v.state='resolved' THEN
    IF v.resolution_id=p_resolution_id AND v.resolution_hash=p_resolution_hash AND v.resolution=p_resolution THEN RETURN; END IF;
    PERFORM rhinoq_task.fail('RHINOQ_WAITPOINT_CONFLICT',p_id);
  END IF;
  IF v.version<>p_expected_version THEN PERFORM rhinoq_task.fail('RHINOQ_VERSION_CONFLICT',p_id); END IF;
  IF v.state<>'waiting' OR (v.deadline IS NOT NULL AND clock_timestamp()>=v.deadline) THEN PERFORM rhinoq_task.fail('RHINOQ_WAITPOINT_SETTLED',p_id); END IF;
  UPDATE rhinoq_task.waitpoints SET state='resolved',resolution=p_resolution,resolution_hash=p_resolution_hash,resolution_id=p_resolution_id,
    resolved_by=p_actor,resolved_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE id=p_id;
  UPDATE rhinoq_task.tasks SET version=version+1,updated_at=clock_timestamp() WHERE id=v.task_id;
END; $$;

CREATE OR REPLACE FUNCTION rhinoq_task.expire_waitpoints(p_limit integer)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_count integer := 0; v record;
BEGIN
  IF p_limit<1 OR p_limit>500 THEN PERFORM rhinoq_task.fail('RHINOQ_INVALID_REQUEST','limit'); END IF;
  FOR v IN SELECT id,task_id FROM rhinoq_task.waitpoints WHERE state='waiting' AND deadline<=clock_timestamp()
    ORDER BY deadline,id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
    UPDATE rhinoq_task.waitpoints SET state='expired',version=version+1,updated_at=clock_timestamp() WHERE id=v.id;
    UPDATE rhinoq_task.tasks SET version=version+1,updated_at=clock_timestamp() WHERE id=v.task_id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END; $$;
`;

const TASK_SCHEMA_MIGRATIONS = [
  { version: 1, name: '001_task_core', sql: TASK_SCHEMA_SQL },
  { version: 2, name: '002_task_summary_aggregates', sql: TASK_SCHEMA_V2_SQL },
  { version: 3, name: '003_execution_supersede_expand', sql: TASK_SCHEMA_V3_SQL },
  { version: 4, name: '004_execution_supersede_contract', sql: TASK_SCHEMA_V4_SQL },
  { version: 5, name: '005_items_settled_signal', sql: TASK_SCHEMA_V5_SQL },
  { version: 6, name: '006_transactional_item_effect', sql: TASK_SCHEMA_V6_SQL },
  { version: 7, name: TASK_SCHEMA_NAME, sql: TASK_SCHEMA_V7_SQL },
] as const;

export interface SqlConnection extends SqlExecutor {
  release(): void;
}

export interface SqlPool extends SqlExecutor {
  connect(): Promise<SqlConnection>;
}

/** Applies only the isolated four-table Task profile. */
export async function migrateTaskSchema(pool: SqlPool): Promise<void> {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('a PostgreSQL pool with connect() is required');
  }
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN', []);
    await connection.query(
      `SELECT pg_advisory_xact_lock($1::bigint)`,
      [7_246_466_201],
    );
    await connection.query(`CREATE SCHEMA IF NOT EXISTS rhinoq_task`, []);
    await connection.query(`CREATE TABLE IF NOT EXISTS rhinoq_task.migrations (
      version integer PRIMARY KEY CHECK (version > 0),
      name text NOT NULL UNIQUE,
      checksum text NOT NULL CHECK (length(checksum) = 64),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`, []);
    for (const migration of TASK_SCHEMA_MIGRATIONS) {
      const checksum = await taskSchemaChecksum(migration.sql);
      const existing = await connection.query<{ name: string; checksum: string }>(
        `SELECT name, checksum FROM rhinoq_task.migrations WHERE version=$1`,
        [migration.version],
      );
      const applied = existing.rows[0];
      if (applied && (applied.name !== migration.name || applied.checksum !== checksum)) {
        throw new Error(`RhinoQ Task migration ${migration.version} checksum drift`);
      }
      if (!applied) {
        await connection.query(migration.sql, []);
        await connection.query(
          `INSERT INTO rhinoq_task.migrations (version, name, checksum) VALUES ($1,$2,$3)`,
          [migration.version, migration.name, checksum],
        );
      }
    }
    await connection.query('COMMIT', []);
  } catch (error) {
    await connection.query('ROLLBACK', []).catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

async function taskSchemaChecksum(sql: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(sql),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')).join('');
}
