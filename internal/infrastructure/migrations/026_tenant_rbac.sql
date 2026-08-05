-- RhinoQ migration 026: tenants, membership and tenant-scoped resources.
--
-- Before this migration RhinoQ had no tenant. Authorization was one operator
-- token plus a list of per-owner Task credentials, and owner scoping was
-- applied by whichever handler remembered to call taskVisibleTo. This
-- migration makes the boundary structural in two ways that do not depend on
-- application code being correct:
--
--   1. every tenant-owned row carries tenant_id NOT NULL;
--   2. every child row references its parent by (id, tenant_id), so a row
--      whose tenant differs from its parent's cannot be inserted at all.
--
-- (2) is the load-bearing half. An application bug that forgets a WHERE clause
-- leaks reads; an application bug that writes a child under another tenant's
-- parent corrupts the boundary permanently. The composite foreign keys below
-- make the second class of bug a constraint violation.
--
-- Existing rows are backfilled into tnt_system. That is a real tenant with
-- real members, not a wildcard: nothing in the runtime treats it as able to
-- see other tenants. Naming it keeps the upgrade auditable — "which rows
-- predate isolation" stays a query rather than an assumption.
SET search_path = public;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rhinoq_tenants (
    id          text PRIMARY KEY CHECK (btrim(id) <> ''),
    slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
    name        text NOT NULL CHECK (btrim(name) <> ''),
    status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now() CHECK (updated_at >= created_at)
);

COMMENT ON TABLE rhinoq_tenants IS
    'The isolation boundary. Suspension gates mutations but preserves evidence.';

-- A principal is not owned by a tenant: one person can belong to several, and
-- deactivating them must take effect everywhere at once rather than requiring
-- every membership to be found and deleted.
CREATE TABLE IF NOT EXISTS rhinoq_principals (
    id            text PRIMARY KEY CHECK (btrim(id) <> ''),
    kind          text NOT NULL CHECK (kind IN ('user', 'service', 'end_user')),
    display_name  text NOT NULL CHECK (btrim(display_name) <> ''),
    disabled      boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now() CHECK (updated_at >= created_at)
);

CREATE TABLE IF NOT EXISTS rhinoq_memberships (
    principal_id  text NOT NULL REFERENCES rhinoq_principals(id) ON DELETE CASCADE,
    tenant_id     text NOT NULL REFERENCES rhinoq_tenants(id) ON DELETE CASCADE,
    role          text NOT NULL CHECK (role IN (
                      'owner', 'admin', 'operator', 'developer', 'viewer', 'task_owner'
                  )),
    -- Empty means tenant-wide. A task_owner without a scope would hold Task
    -- read and write across every customer in the tenant from a credential
    -- meant for one browser, so the database refuses that row too.
    owner_scope   text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now() CHECK (updated_at >= created_at),
    PRIMARY KEY (principal_id, tenant_id),
    CONSTRAINT rhinoq_memberships_scoped_role_check
        CHECK (role <> 'task_owner' OR btrim(owner_scope) <> ''),
    -- Referenced by the credential table so a credential cannot outlive the
    -- membership that gave it meaning.
    UNIQUE (principal_id, tenant_id, role)
);

CREATE INDEX IF NOT EXISTS rhinoq_memberships_tenant_role_idx
    ON rhinoq_memberships (tenant_id, role);

-- Partial unique index, not a CHECK: the last-owner rule is about the set of
-- rows in a tenant, and this is the cheap half of it — see the owner count
-- guard in the store for the transactional half.
CREATE INDEX IF NOT EXISTS rhinoq_memberships_owner_idx
    ON rhinoq_memberships (tenant_id)
    WHERE role = 'owner';

-- A credential authenticates a principal *into one tenant*. Binding the token
-- to the membership rather than to the principal is what makes tenant
-- selection unforgeable: there is no request header that can widen it.
CREATE TABLE IF NOT EXISTS rhinoq_credentials (
    id            text PRIMARY KEY CHECK (btrim(id) <> ''),
    principal_id  text NOT NULL,
    tenant_id     text NOT NULL,
    -- sha256 of the presented bearer token. The token itself is shown once at
    -- creation and never stored, so a database disclosure is not a set of
    -- working credentials.
    token_sha256  bytea NOT NULL UNIQUE CHECK (octet_length(token_sha256) = 32),
    description   text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz,
    revoked_at    timestamptz,
    last_used_at  timestamptz,
    FOREIGN KEY (principal_id, tenant_id)
        REFERENCES rhinoq_memberships (principal_id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS rhinoq_credentials_principal_idx
    ON rhinoq_credentials (principal_id, tenant_id);

-- ---------------------------------------------------------------------------
-- Backfill tenant
-- ---------------------------------------------------------------------------

INSERT INTO rhinoq_tenants (id, slug, name, status)
VALUES ('tnt_system', 'system', 'System (pre-RBAC rows)', 'active')
ON CONFLICT (id) DO NOTHING;

-- rhinoq.tenant_id is read with missing_ok = true so an unset variable is NULL
-- rather than an error, and NULLIF maps an empty value to NULL as well: a
-- connection string that sets the option to nothing is the same mistake as not
-- setting it. NULL against a NOT NULL column then refuses the write, which is
-- the intended reading of "nobody said which tenant".
--
-- This lives in 026 rather than alongside the policies in 027 for an upgrade
-- reason. The column below is NOT NULL, so between a 026 that leaves no
-- default and a 027 that adds one there is a window where every INSERT from a
-- running binary fails. Defining the function here and defaulting the column
-- to it in the same migration closes that window: an operator who has already
-- put the tenant option on the connection string keeps writing throughout the
-- upgrade. See docs/migration-rollback.md.
CREATE OR REPLACE FUNCTION rhinoq_current_tenant() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('rhinoq.tenant_id', true), '') $$;

COMMENT ON FUNCTION rhinoq_current_tenant IS
    'The tenant of the current session, or NULL. NULL denies every row-level policy and fails every insert.';

-- Parents first, then children, so each composite foreign key has something to
-- point at when it is created.
ALTER TABLE rhinoq_tasks
    ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'tnt_system'
        REFERENCES rhinoq_tenants(id);
ALTER TABLE rhinoq_jobs
    ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'tnt_system'
        REFERENCES rhinoq_tenants(id);
ALTER TABLE rhinoq_findings
    ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'tnt_system'
        REFERENCES rhinoq_tenants(id);
ALTER TABLE rhinoq_rules
    ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'tnt_system'
        REFERENCES rhinoq_tenants(id);
ALTER TABLE rhinoq_repairs
    ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'tnt_system'
        REFERENCES rhinoq_tenants(id);
ALTER TABLE rhinoq_provider_operations
    ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'tnt_system'
        REFERENCES rhinoq_tenants(id);
ALTER TABLE rhinoq_queue_controls
    ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'tnt_system'
        REFERENCES rhinoq_tenants(id);

-- The literal 'tnt_system' default above exists only to backfill existing rows
-- in one statement. Leaving it would mean a writer that forgets tenant_id
-- silently lands in tnt_system, which is the quietest possible way to lose
-- isolation: no error, no log line, wrong tenant.
--
-- It is replaced rather than dropped. Dropping it would make the column NOT
-- NULL with no default, and every INSERT already in flight from a running
-- binary would fail from this statement onward. Defaulting to the session
-- tenant keeps those writes working — and still refuses them when no tenant
-- was announced, because the function returns NULL.
ALTER TABLE rhinoq_tasks               ALTER COLUMN tenant_id SET DEFAULT rhinoq_current_tenant();
ALTER TABLE rhinoq_jobs                ALTER COLUMN tenant_id SET DEFAULT rhinoq_current_tenant();
ALTER TABLE rhinoq_findings            ALTER COLUMN tenant_id SET DEFAULT rhinoq_current_tenant();
ALTER TABLE rhinoq_rules               ALTER COLUMN tenant_id SET DEFAULT rhinoq_current_tenant();
ALTER TABLE rhinoq_repairs             ALTER COLUMN tenant_id SET DEFAULT rhinoq_current_tenant();
ALTER TABLE rhinoq_provider_operations ALTER COLUMN tenant_id SET DEFAULT rhinoq_current_tenant();
ALTER TABLE rhinoq_queue_controls      ALTER COLUMN tenant_id SET DEFAULT rhinoq_current_tenant();

-- ---------------------------------------------------------------------------
-- Make cross-tenant references unrepresentable
-- ---------------------------------------------------------------------------

-- The (id, tenant_id) keys are redundant with the primary key by themselves;
-- they exist so children can reference the pair and inherit the tenant through
-- the constraint rather than through a correct INSERT.
ALTER TABLE rhinoq_tasks
    ADD CONSTRAINT rhinoq_tasks_id_tenant_key UNIQUE (id, tenant_id);

ALTER TABLE rhinoq_task_executions
    ADD COLUMN IF NOT EXISTS tenant_id text;

UPDATE rhinoq_task_executions execution
SET tenant_id = parent.tenant_id
FROM rhinoq_tasks parent
WHERE execution.task_id = parent.id AND execution.tenant_id IS DISTINCT FROM parent.tenant_id;

ALTER TABLE rhinoq_task_executions
    ALTER COLUMN tenant_id SET NOT NULL,
    ALTER COLUMN tenant_id SET DEFAULT rhinoq_current_tenant();

ALTER TABLE rhinoq_task_executions
    ADD CONSTRAINT rhinoq_task_executions_task_tenant_fkey
    FOREIGN KEY (task_id, tenant_id)
    REFERENCES rhinoq_tasks (id, tenant_id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS rhinoq_task_executions_tenant_idx
    ON rhinoq_task_executions (tenant_id, task_id);

-- Provider operation evidence follows its operation the same way.
ALTER TABLE rhinoq_provider_operations
    ADD CONSTRAINT rhinoq_provider_operations_id_tenant_key UNIQUE (id, tenant_id);

ALTER TABLE rhinoq_provider_operation_evidence
    ADD COLUMN IF NOT EXISTS tenant_id text;

UPDATE rhinoq_provider_operation_evidence evidence
SET tenant_id = parent.tenant_id
FROM rhinoq_provider_operations parent
WHERE evidence.operation_id = parent.id
  AND evidence.tenant_id IS DISTINCT FROM parent.tenant_id;

ALTER TABLE rhinoq_provider_operation_evidence
    ALTER COLUMN tenant_id SET NOT NULL,
    ALTER COLUMN tenant_id SET DEFAULT rhinoq_current_tenant();

ALTER TABLE rhinoq_provider_operation_evidence
    ADD CONSTRAINT rhinoq_provider_operation_evidence_tenant_fkey
    FOREIGN KEY (operation_id, tenant_id)
    REFERENCES rhinoq_provider_operations (id, tenant_id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- Tenant-leading indexes
-- ---------------------------------------------------------------------------
--
-- Every list query now filters by tenant first. Without tenant as the leading
-- column these become a scan of every tenant's rows followed by a filter,
-- which is both slow and the shape that makes a missing WHERE clause hard to
-- notice in a plan.

CREATE INDEX IF NOT EXISTS rhinoq_tasks_tenant_owner_updated_idx
    ON rhinoq_tasks (tenant_id, owner_id, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS rhinoq_tasks_tenant_state_updated_idx
    ON rhinoq_tasks (tenant_id, state, updated_at, id);

CREATE INDEX IF NOT EXISTS rhinoq_jobs_tenant_state_idx
    ON rhinoq_jobs (tenant_id, state, id);

-- Mirrors rhinoq_findings_inbox_idx with tenant leading, so the operator inbox
-- stays one index scan per tenant rather than a scan of every tenant's inbox.
CREATE INDEX IF NOT EXISTS rhinoq_findings_tenant_inbox_idx
    ON rhinoq_findings (tenant_id, status, updated_at DESC)
    WHERE status <> 'resolved';

CREATE INDEX IF NOT EXISTS rhinoq_rules_tenant_idx
    ON rhinoq_rules (tenant_id, id, version);

CREATE INDEX IF NOT EXISTS rhinoq_repairs_tenant_idx
    ON rhinoq_repairs (tenant_id, id);

CREATE INDEX IF NOT EXISTS rhinoq_provider_operations_tenant_idx
    ON rhinoq_provider_operations (tenant_id, id);

-- Queue controls were keyed by name alone, which made "pause the exports
-- queue" a global action for every tenant that happened to use that name.
ALTER TABLE rhinoq_queue_controls
    DROP CONSTRAINT IF EXISTS rhinoq_queue_controls_pkey;
ALTER TABLE rhinoq_queue_controls
    ADD PRIMARY KEY (tenant_id, queue_name);
