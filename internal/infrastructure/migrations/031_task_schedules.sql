CREATE TABLE IF NOT EXISTS rhinoq_task_schedules (
    id text NOT NULL CHECK (length(btrim(id)) > 0),
    tenant_id text NOT NULL DEFAULT rhinoq_current_tenant() REFERENCES rhinoq_tenants(id),
    task_name text NOT NULL CHECK (length(btrim(task_name)) > 0),
    owner_id text NOT NULL CHECK (length(btrim(owner_id)) > 0),
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    every_ms bigint NOT NULL CHECK (every_ms BETWEEN 60000 AND 31536000000),
    enabled boolean NOT NULL DEFAULT true,
    next_run_at timestamptz NOT NULL,
    lease_owner text,
    lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
    lease_expires_at timestamptz,
    last_started_at timestamptz,
    last_completed_at timestamptz,
    last_error text NOT NULL DEFAULT '',
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (id, tenant_id),
    CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);

CREATE INDEX IF NOT EXISTS rhinoq_task_schedules_due_idx
ON rhinoq_task_schedules(tenant_id, next_run_at, id)
WHERE enabled = true;

ALTER TABLE rhinoq_task_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE rhinoq_task_schedules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rhinoq_tenant_isolation ON rhinoq_task_schedules;
CREATE POLICY rhinoq_tenant_isolation ON rhinoq_task_schedules
    USING (tenant_id = rhinoq_current_tenant() OR rhinoq_maintenance_session())
    WITH CHECK (tenant_id = rhinoq_current_tenant());
