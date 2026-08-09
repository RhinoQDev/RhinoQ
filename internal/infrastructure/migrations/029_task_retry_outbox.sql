-- RhinoQ migration 029: crash-safe, idempotent Task retry commands.
SET search_path = public;

-- The retry command must point to an Execution of the same Task and tenant,
-- not merely to any globally valid Execution id.
ALTER TABLE rhinoq_task_executions
    ADD CONSTRAINT rhinoq_task_executions_id_task_tenant_key
    UNIQUE (id, task_id, tenant_id);

CREATE TABLE IF NOT EXISTS rhinoq_task_retry_commands (
    command_id text NOT NULL CHECK (btrim(command_id) <> ''),
    tenant_id text NOT NULL DEFAULT rhinoq_current_tenant() REFERENCES rhinoq_tenants(id),
    task_id text NOT NULL,
    execution_id text NOT NULL,
    dispatch_fingerprint text NOT NULL CHECK (length(dispatch_fingerprint) = 64),
    expected_version bigint NOT NULL CHECK (expected_version > 0),
    created_at timestamptz NOT NULL,
    PRIMARY KEY (command_id, tenant_id),
    UNIQUE (execution_id, tenant_id),
    FOREIGN KEY (task_id, tenant_id) REFERENCES rhinoq_tasks(id, tenant_id) ON DELETE CASCADE,
    FOREIGN KEY (execution_id, task_id, tenant_id)
        REFERENCES rhinoq_task_executions(id, task_id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS rhinoq_task_retry_commands_task_idx
    ON rhinoq_task_retry_commands (tenant_id, task_id, created_at, command_id);

ALTER TABLE rhinoq_task_retry_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE rhinoq_task_retry_commands FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rhinoq_tenant_isolation ON rhinoq_task_retry_commands;
CREATE POLICY rhinoq_tenant_isolation ON rhinoq_task_retry_commands
    USING (tenant_id = rhinoq_current_tenant() OR rhinoq_maintenance_session())
    WITH CHECK (tenant_id = rhinoq_current_tenant());
