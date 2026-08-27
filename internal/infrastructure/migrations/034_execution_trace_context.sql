-- W3C trace context on the Execution.
--
-- RhinoQ can already explain what it did: attempts, stages, effects, evidence.
-- What it could not do is answer the first question an operator actually asks,
-- which is "show me this failure in the trace it came from". Without a join key
-- the answer was found by comparing timestamps between the Workbench and an
-- APM, by hand, during an incident.
--
-- The columns are nullable because absence is a real and common state, not a
-- defect: a Task started by a scheduler, a CLI command or a backfill has no
-- inbound request and therefore no trace. A default would have manufactured a
-- key that joins to nothing, which is worse than an honest NULL.
--
-- They live on the Execution rather than the Task because a Task is retried.
-- Attempt 1 may come from a user request and attempt 3 from a retry sweep;
-- storing one trace per Task would attribute every later attempt to whoever
-- happened to be first.
ALTER TABLE rhinoq_task_executions
    ADD COLUMN IF NOT EXISTS trace_id      text,
    ADD COLUMN IF NOT EXISTS trace_span_id text,
    ADD COLUMN IF NOT EXISTS trace_flags   text,
    ADD COLUMN IF NOT EXISTS trace_state   text;

-- The shape is constrained here as well as in the domain. A row can be written
-- by a migration, a backfill or a future adapter, and a 32-hex join key that
-- silently becomes 31 characters produces a lookup that returns nothing with no
-- error to explain why.
--
-- Trace id and span id travel together: half a trace context cannot be joined
-- on and cannot be forwarded, so the pair is either wholly present or wholly
-- absent.
ALTER TABLE rhinoq_task_executions
    DROP CONSTRAINT IF EXISTS rhinoq_task_execution_trace_shape_check;
ALTER TABLE rhinoq_task_executions
    ADD CONSTRAINT rhinoq_task_execution_trace_shape_check CHECK (
        (trace_id IS NULL AND trace_span_id IS NULL) OR
        (
            trace_id ~ '^[0-9a-f]{32}$' AND
            trace_id <> repeat('0', 32) AND
            trace_span_id ~ '^[0-9a-f]{16}$' AND
            trace_span_id <> repeat('0', 16) AND
            (trace_flags IS NULL OR trace_flags ~ '^[0-9a-f]{2}$') AND
            (trace_state IS NULL OR length(trace_state) <= 512)
        )
    );

-- The index is partial because most rows have no trace, and the only query it
-- serves is the operator's: given a trace id from an APM, find the attempts
-- that belong to it. Indexing the NULLs would pay for rows that can never
-- match.
CREATE INDEX IF NOT EXISTS rhinoq_task_executions_trace_id_idx
    ON rhinoq_task_executions (trace_id)
    WHERE trace_id IS NOT NULL;
