# Tenants, roles and isolation

RhinoQ's tenant boundary is enforced by PostgreSQL, not by application code.
This document says what that means, what it does not cover, and the one
configuration mistake that silently turns all of it off.

## The model

| Concept | What it is |
|---|---|
| Tenant | The isolation boundary. Every tenant-owned row carries `tenant_id`. |
| Principal | An actor — `user`, `service` or `end_user`. Not owned by a tenant; one person can belong to several. |
| Membership | One principal in one tenant with one role. Revoking it cascades to that principal's credentials. |
| Credential | A bearer token, stored only as a SHA-256 hash, bound to a *membership*. |
| Owner scope | Narrows a membership to resources carrying one owner id. Empty means tenant-wide. |

A credential is bound to the membership rather than to the principal, which is
what makes tenant selection unforgeable: there is no request header that can
widen it, because the token names the tenant.

## Roles

| Role | Holds | Deliberately does not hold |
|---|---|---|
| `owner` | everything | — |
| `admin` | everything operational, plus membership | `tenant:administer` — so a rogue admin can be removed |
| `operator` | read, write, operate, `repair:approve` | membership — so it cannot mint a second identity to satisfy the different-approver rule |
| `developer` | read, write Rules/Tasks/Jobs | `repair:approve` — authoring the Rule and approving the repair it justifies is one person holding both ends |
| `viewer` | read, except membership | who else has access is administrative |
| `task_owner` | `task:read`, `task:write` | anything else; requires an owner scope, enforced in Go *and* by a check constraint |

## Two gates, independently

Every decision passes through `authz.Authorize`, which evaluates the role gate
and the tenant gate separately. Neither implies the other: an `owner` of tenant
A holds every permission and still cannot read a Task of tenant B.

Cross-tenant and out-of-scope denials are **concealed as not-found**. Answering
`403` for a resource in another tenant and `404` for an id that was never
issued turns any endpoint into an oracle for "does tenant B have this id". A
role denial inside your own tenant is reported plainly, because you can already
see the resource exists.

## The mistake that turns this off

PostgreSQL exempts **superusers** and any role with **BYPASSRLS** from
row-level security — `FORCE ROW LEVEL SECURITY` included. The official
`postgres` Docker image makes `POSTGRES_USER` a superuser.

Connect RhinoQ as that role and every tenant policy is ignored, every tenant
shares one dataset, and nothing anywhere reports an error. Your tests still
pass. This is not a hypothetical: it is what happened while this feature was
being built, and it was caught only by a test that tried to read across the
boundary on purpose.

So RhinoQ checks. `rhinoq doctor` reports it as a **FAIL**:

```console
Tenant isolation
  FAIL tenant isolation is not in force
       the role "rhinoq" holds SUPERUSER, so PostgreSQL ignores every tenant
       policy and all tenants share one dataset; connect as a role created
       with NOSUPERUSER NOBYPASSRLS
```

Create the application role explicitly:

```sql
CREATE ROLE rhinoq_app LOGIN PASSWORD '...'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO rhinoq_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rhinoq_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rhinoq_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO rhinoq_app;
```

Migrations still run as the owner. The runtime must not.

## Announcing the tenant

The session variable `rhinoq.tenant_id` selects the tenant. Set it on the
connection string so there is no window in which a pooled connection is live
without one:

```
postgres://rhinoq_app:...@host:5432/rhinoq?options=-c%20rhinoq.tenant_id%3Dtnt_acme
```

A session that never sets it reads nothing and cannot write: the policy
comparison is `NULL`, and the `tenant_id` default resolves to `NULL` against a
`NOT NULL` column. Both failures are deliberate.

Background work that is legitimately cross-tenant — retention, the notification
scheduler, recovery sweeps — sets `rhinoq.maintenance=on` instead.

## Embedded Node Task profile

Task schema migration 014 applies the same PostgreSQL RLS boundary to the isolated
rhinoq_task profile. Every Task-owned table has forced RLS, child rows carry
tenant_id, and parent references use the tenant key or a tenant-checking trigger.
The exported `inspectTaskRls()` and `requireTaskRls()` helpers inspect the live
role and forced policies.

There are two ways to announce the tenant, and they are for two different
deployments. Pick by how many tenants one process serves, not by which looks
newer.

### One tenant per process — connection string

The simplest correct design when a process serves a single tenant. Bake the
tenant into the pool's connection options and every query on that pool is
already scoped:

```js
const pool = new pg.Pool({
  connectionString: 'postgres://rhinoq_app:...@host:5432/rhinoq'
    + '?options=-c%20rhinoq.tenant_id%3Dtnt_acme',
});
const tasks = await installPostgresTaskProfile(pool);
```

This is what every example under `examples/` does. Nothing about it is
deprecated: for one tenant it is the right amount of machinery.

### Many tenants per process — `withTenant()`

A SaaS backend serving many tenants must not open one pool per tenant. PostgreSQL
defaults to 100 connections and the ceiling is shared with every other client of
the server, so a handful of tenants at a modest pool size each already exhausts
it. Open **one** tenant-less pool and name the tenant per unit of work instead:

```js
const pool = new pg.Pool({ connectionString: DATABASE_URL });   // no tenant here
const tasks = new PostgresTaskClient(pool);

// Per request: bind the tenant for the length of one transaction.
await tasks.withTenant(request.tenantId, async (scoped) => {
  await scoped.createTask({ id, type, ownerId, definitionVersion: 1 });
});
```

`withTenant` sets `rhinoq.tenant_id` with `set_config(..., true)` — `SET LOCAL`,
so the binding lives for that transaction and is gone when the connection returns
to the pool. The callback receives a client bound to the checked-out connection;
using the outer `tasks` inside it would run on a different connection, outside
both the transaction and the binding. The tenant id is validated against
`assertTenantId()` first, because a value carrying whitespace could otherwise
smuggle a second `-c` startup option onto the connection.

Isolation is still PostgreSQL's, not the callback's. A forgotten predicate
inside `withTenant` returns zero rows exactly as it would with the connection
string; `tenantFromRequest` and SQL predicates are a convenience on top of the
database context, never a substitute for it. The runnable proof — two tenants on
one shared pool, each blind to the other, on a `NOSUPERUSER NOBYPASSRLS` role —
is `sdks/node/test/tenant-transaction.integration.test.mjs`.

## What the boundary does and does not defend against

**Does** defend against application bugs: a missing `WHERE tenant_id`, a copied
query, a new endpoint that forgets scoping. That is the failure mode this
codebase actually had, and it is now structurally prevented — a forgotten
predicate returns zero rows instead of another tenant's data.

Cross-tenant *references* are prevented separately, by composite foreign keys
on `(id, tenant_id)`. Row-level security filters rows; it cannot stop a child
row being attached to a parent in another tenant, because from the writer's
side both ids are just strings. `rhinoq_task_executions` and
`rhinoq_provider_operation_evidence` reference their parent by the pair, so
that insert is a constraint violation rather than a policy question.

**Does not** defend against a hostile process that already holds these database
credentials. `rhinoq.tenant_id` is an ordinary custom GUC and any session may
`SET` it; PostgreSQL 16 offers no privilege that restricts a custom parameter.
A threat model that includes a compromised Agent needs one database role per
tenant with its own policy. That is a deployment decision and RhinoQ does not
currently automate it.

## Upgrading an existing install

Migration 026 backfills every existing row into `tnt_system`, a real tenant
with real members — not a wildcard. Nothing treats it as able to see other
tenants. Naming it keeps the upgrade auditable: "which rows predate isolation"
stays a query.

The column default is dropped immediately after the backfill. A store that
forgets `tenant_id` then fails rather than silently writing into `tnt_system`.

## Still open

- The API-level `Subject` resolution described above exists in
  `internal/domain/authz` and is enforced by the database. Wiring the agent's
  HTTP surface to resolve a credential into a `Subject` per request — replacing
  the operator-token-plus-owner-list model in
  `internal/interfaces/agent/server.go` — is not done.
- The embedded Node Task profile now serves many tenants from one pool through
  `PostgresTaskClient.withTenant()` (see above), which takes the per-request
  `SET LOCAL` inside a transaction-scoped handle. The Go Agent's HTTP surface
  still binds one tenant per process at the pool; giving it the same
  per-request handle is not done.
- The Node PostgreSQL integration harness exercises owner API reads across both
  tenant and owner boundaries and requires 404 without metadata. The full Go
  PostgreSQL harness separately runs storage enforcement through a
  `NOSUPERUSER NOBYPASSRLS` application role. These are complementary checks;
  the embedded Node Task profile now enforces forced RLS in migration 014; both
  its one-tenant-per-pool and shared-pool `withTenant()` deployment models are
  documented above.