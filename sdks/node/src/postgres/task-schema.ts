import type { SqlExecutor } from './producer.js';

export const TASK_SCHEMA_VERSION = 1;
export const TASK_SCHEMA_NAME = '001_task_core';

/**
 * Task-only PostgreSQL profile.
 *
 * It deliberately owns exactly three tables in a dedicated schema:
 * migrations, tasks and executions. Runtime, Effect, Rule and Finding tables
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

export interface SqlConnection extends SqlExecutor {
  release(): void;
}

export interface SqlPool extends SqlExecutor {
  connect(): Promise<SqlConnection>;
}

/** Applies only the isolated three-table Task profile. */
export async function migrateTaskSchema(pool: SqlPool): Promise<void> {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('a PostgreSQL pool with connect() is required');
  }
  const connection = await pool.connect();
  try {
    const checksum = await taskSchemaChecksum();
    await connection.query('BEGIN', []);
    await connection.query(
      `SELECT pg_advisory_xact_lock($1::bigint)`,
      [7_246_466_201],
    );
    await connection.query(TASK_SCHEMA_SQL, []);
    const existing = await connection.query<{
      name: string;
      checksum: string;
    }>(
      `SELECT name, checksum
       FROM rhinoq_task.migrations
       WHERE version = $1`,
      [TASK_SCHEMA_VERSION],
    );
    const applied = existing.rows[0];
    if (applied && (
      applied.name !== TASK_SCHEMA_NAME ||
      applied.checksum !== checksum
    )) {
      throw new Error(
        `RhinoQ Task migration ${TASK_SCHEMA_VERSION} checksum drift`,
      );
    }
    if (!applied) {
      await connection.query(
        `INSERT INTO rhinoq_task.migrations (version, name, checksum)
         VALUES ($1, $2, $3)`,
        [TASK_SCHEMA_VERSION, TASK_SCHEMA_NAME, checksum],
      );
    }
    await connection.query('COMMIT', []);
  } catch (error) {
    await connection.query('ROLLBACK', []).catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

async function taskSchemaChecksum(): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(TASK_SCHEMA_SQL),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')).join('');
}
