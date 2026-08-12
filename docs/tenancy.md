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
- One process serves one tenant, because the tenant is a property of the
  connection pool. Serving many tenants from one Agent needs per-request
  `SET LOCAL` inside a transaction-scoped handle, which the adapters do not
  currently take.
- The Node PostgreSQL integration harness exercises owner API reads across both
  tenant and owner boundaries and requires 404 without metadata. The full Go
  PostgreSQL harness separately runs storage enforcement through a
  `NOSUPERUSER NOBYPASSRLS` application role. These are complementary checks;
  the embedded Node Task profile enforces tenant predicates rather than the
  full profile's RLS policies.
