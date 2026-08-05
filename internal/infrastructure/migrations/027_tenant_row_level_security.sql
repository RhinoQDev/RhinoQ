-- RhinoQ migration 027: enforce the tenant boundary in PostgreSQL.
--
-- Migration 026 gave every tenant-owned row a tenant_id. That alone does not
-- isolate anything: isolation would still depend on all 4,343 lines of adapter
-- SQL carrying the right predicate, forever, including in code not yet
-- written. One forgotten `AND tenant_id = $n` is a cross-tenant read, and it
-- is invisible in review because the query looks correct.
--
-- So the predicate moves into the database. Every tenant-owned table gets a
-- row-level policy keyed on one session variable, and every tenant_id column
-- defaults from the same variable. An adapter that forgets the tenant now
-- reads zero rows instead of somebody else's, and an INSERT that forgets it
-- fails instead of silently landing in the wrong tenant.
--
-- WHAT THIS DEFENDS AGAINST, PRECISELY
--
-- This defends against application bugs: a missing predicate, a copied query,
-- a new endpoint that forgets scoping. That is the failure this codebase
-- actually has, and it is now structurally prevented.
--
-- This does NOT defend against a hostile process that already holds these
-- database credentials. rhinoq.tenant_id is an ordinary custom GUC and any
-- session may SET it; PostgreSQL 16 offers no privilege that restricts a
-- custom parameter. A threat model that includes a compromised Agent needs
-- one database role per tenant with its own policy, which is a deployment
-- decision and is documented as such in docs/postgres.md rather than
-- pretended to here.
SET search_path = public;

-- rhinoq_current_tenant() is defined in 026, not here, so the tenant_id
-- columns can default to it in the same migration that makes them NOT NULL.
-- A NULL return makes every policy comparison below NULL, which is not true,
-- which denies. Failing closed on "nobody said which tenant" is the only safe
-- reading of that state.
--
-- Maintenance work — retention, the notification scheduler, recovery sweeps,
-- the projector — is legitimately cross-tenant. It opts out explicitly and
-- visibly rather than by holding a credential that quietly sees everything.
CREATE OR REPLACE FUNCTION rhinoq_maintenance_session() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT coalesce(current_setting('rhinoq.maintenance', true), '') = 'on' $$;

COMMENT ON FUNCTION rhinoq_maintenance_session IS
    'True for a deliberately cross-tenant maintenance session. Not a security boundary: see migration 027.';

DO $$
DECLARE
    target text;
BEGIN
    FOREACH target IN ARRAY ARRAY[
        'rhinoq_tasks',
        'rhinoq_task_executions',
        'rhinoq_jobs',
        'rhinoq_findings',
        'rhinoq_rules',
        'rhinoq_repairs',
        'rhinoq_provider_operations',
        'rhinoq_provider_operation_evidence',
        'rhinoq_queue_controls'
    ]
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
        -- FORCE matters more than ENABLE here. Without it the table owner —
        -- which is the role the Agent and the test harness both connect as —
        -- bypasses every policy, and the isolation would be a no-op that
        -- passes review.
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);

        EXECUTE format('DROP POLICY IF EXISTS rhinoq_tenant_isolation ON %I', target);
        -- USING filters what is visible to SELECT, UPDATE and DELETE.
        -- WITH CHECK constrains what INSERT and UPDATE may write, and it is
        -- the half that stops a write from moving a row into another tenant.
        -- Omitting WITH CHECK would leave `UPDATE ... SET tenant_id = 'other'`
        -- legal for anything already visible.
        EXECUTE format($policy$
            CREATE POLICY rhinoq_tenant_isolation ON %I
            USING (tenant_id = rhinoq_current_tenant() OR rhinoq_maintenance_session())
            WITH CHECK (tenant_id = rhinoq_current_tenant() OR rhinoq_maintenance_session())
        $policy$, target);
    END LOOP;
END
$$;

-- The identity tables are not tenant-owned in the same way and need their own
-- treatment. rhinoq_tenants is readable only as the session's own tenant, so a
-- credential cannot enumerate the customer list.
ALTER TABLE rhinoq_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE rhinoq_tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rhinoq_tenant_self ON rhinoq_tenants;
CREATE POLICY rhinoq_tenant_self ON rhinoq_tenants
    USING (id = rhinoq_current_tenant() OR rhinoq_maintenance_session())
    WITH CHECK (id = rhinoq_current_tenant() OR rhinoq_maintenance_session());

ALTER TABLE rhinoq_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE rhinoq_memberships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rhinoq_membership_tenant ON rhinoq_memberships;
CREATE POLICY rhinoq_membership_tenant ON rhinoq_memberships
    USING (tenant_id = rhinoq_current_tenant() OR rhinoq_maintenance_session())
    WITH CHECK (tenant_id = rhinoq_current_tenant() OR rhinoq_maintenance_session());

ALTER TABLE rhinoq_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE rhinoq_credentials FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rhinoq_credential_tenant ON rhinoq_credentials;
CREATE POLICY rhinoq_credential_tenant ON rhinoq_credentials
    USING (tenant_id = rhinoq_current_tenant() OR rhinoq_maintenance_session())
    WITH CHECK (tenant_id = rhinoq_current_tenant() OR rhinoq_maintenance_session());

-- rhinoq_principals is deliberately left without a policy. A principal spans
-- tenants, and the authentication path has to resolve one before any tenant is
-- known — a policy here would make login impossible to perform. What protects
-- it is that it holds no secret: tokens live in rhinoq_credentials as hashes,
-- and that table is scoped.
