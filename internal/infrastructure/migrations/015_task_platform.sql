-- RhinoQ migration 015: durable Task and Execution foundations.
--
-- Task is user-facing state. Execution is one attempt and may bind either to a
-- native RhinoQ Job or to a stable external-runtime identifier. Retry creates a
-- new row with the next attempt; terminal executions are never reopened.
SET search_path = public;

CREATE TABLE IF NOT EXISTS rhinoq_tasks (
    id                  text PRIMARY KEY,
    type                text NOT NULL CHECK (btrim(type) <> ''),
    owner_id            text,
    definition_version  integer NOT NULL CHECK (definition_version > 0),
    state               text NOT NULL CHECK (state IN (
                            'pending', 'queued', 'running', 'succeeded',
                            'failed', 'cancel_requested', 'cancelled'
                        )),
    progress_completed  bigint NOT NULL DEFAULT 0 CHECK (progress_completed >= 0),
    progress_total      bigint CHECK (
                            progress_total >= 0 AND
                            progress_total >= progress_completed
                        ),
    progress_message    text,
    result_ref          text,
    version             bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at          timestamptz NOT NULL,
    updated_at          timestamptz NOT NULL CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS rhinoq_tasks_owner_updated_idx
    ON rhinoq_tasks (owner_id, updated_at DESC, id)
    WHERE owner_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS rhinoq_tasks_state_updated_idx
    ON rhinoq_tasks (state, updated_at, id);

CREATE TABLE IF NOT EXISTS rhinoq_task_executions (
    id           text PRIMARY KEY,
    task_id      text NOT NULL REFERENCES rhinoq_tasks(id) ON DELETE CASCADE,
    attempt      integer NOT NULL CHECK (attempt > 0),
    runtime      text NOT NULL CHECK (btrim(runtime) <> ''),
    job_id       text REFERENCES rhinoq_jobs(id),
    external_id  text,
    state        text NOT NULL CHECK (state IN (
                     'pending_dispatch', 'dispatched', 'running', 'succeeded',
                     'failed', 'stalled', 'cancelled'
                 )),
    version      bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at   timestamptz NOT NULL,
    updated_at   timestamptz NOT NULL CHECK (updated_at >= created_at),
    UNIQUE (task_id, attempt),
    CONSTRAINT rhinoq_task_execution_reference_check CHECK (
        (runtime = 'native' AND job_id IS NOT NULL AND external_id IS NULL) OR
        (runtime <> 'native' AND external_id IS NOT NULL AND job_id IS NULL) OR
        (job_id IS NULL AND external_id IS NULL AND state IN ('pending_dispatch', 'cancelled'))
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS rhinoq_task_executions_job_unique
    ON rhinoq_task_executions (job_id)
    WHERE job_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS rhinoq_task_executions_external_unique
    ON rhinoq_task_executions (runtime, external_id)
    WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS rhinoq_task_executions_task_idx
    ON rhinoq_task_executions (task_id, attempt);
