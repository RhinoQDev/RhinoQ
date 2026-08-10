-- Durable input/approval/webhook boundary. Resolution identity makes a retry
-- return the committed answer and prevents a second actor from overwriting it.
CREATE TABLE IF NOT EXISTS rhinoq_task_waitpoints (
    id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
    tenant_id text NOT NULL DEFAULT rhinoq_current_tenant() REFERENCES rhinoq_tenants(id),
    task_id text NOT NULL,
    key text NOT NULL CHECK (length(btrim(key)) > 0),
    kind text NOT NULL CHECK (kind IN ('input','approval','webhook')),
    schema_version integer NOT NULL CHECK (schema_version > 0),
    state text NOT NULL CHECK (state IN ('waiting','resolved','expired','cancelled')),
    deadline timestamptz,
    resolution jsonb,
    resolution_hash text,
    resolution_id text,
    resolved_by text,
    resolved_at timestamptz,
    version bigint NOT NULL CHECK (version > 0),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (task_id, key, tenant_id),
    FOREIGN KEY (task_id, tenant_id) REFERENCES rhinoq_tasks(id, tenant_id) ON DELETE CASCADE,
    CHECK (deadline IS NULL OR deadline > created_at),
    CHECK (
      (state = 'resolved' AND resolution IS NOT NULL AND resolution_hash IS NOT NULL
       AND resolution_id IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
      OR
      (state <> 'resolved' AND resolution IS NULL AND resolution_hash IS NULL
       AND resolution_id IS NULL AND resolved_by IS NULL AND resolved_at IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS rhinoq_task_waitpoints_resolution_id_uq
ON rhinoq_task_waitpoints(resolution_id, tenant_id) WHERE resolution_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS rhinoq_task_waitpoints_due_idx
ON rhinoq_task_waitpoints(tenant_id, deadline, id) WHERE state = 'waiting' AND deadline IS NOT NULL;

CREATE INDEX IF NOT EXISTS rhinoq_task_waitpoints_task_idx
ON rhinoq_task_waitpoints(tenant_id, task_id, created_at, id);

ALTER TABLE rhinoq_task_waitpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE rhinoq_task_waitpoints FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rhinoq_tenant_isolation ON rhinoq_task_waitpoints;
CREATE POLICY rhinoq_tenant_isolation ON rhinoq_task_waitpoints
    USING (tenant_id = rhinoq_current_tenant() OR rhinoq_maintenance_session())
    WITH CHECK (tenant_id = rhinoq_current_tenant());
