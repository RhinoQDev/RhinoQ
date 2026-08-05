package postgres_test

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/adapters/postgres"
)

// The suite that already exists proves the runtime still works with tenant
// isolation switched on. It cannot prove isolation, because every connection
// in it belongs to the same tenant. These tests open a second tenant and try
// to cross the boundary on purpose.
//
// Each one is written as an attack rather than a feature: the assertion is
// that something failed, and the test fails if it succeeded.

// Both pools below connect as the unprivileged application role. Using the
// owner would exempt them from row-level security and every assertion here
// would hold for the wrong reason.
func appURL(t *testing.T) string {
	t.Helper()
	raw := os.Getenv("RHINOQ_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	url, err := asApplicationRole(raw)
	if err != nil {
		t.Fatalf("rewrite database url: %v", err)
	}
	return url
}

func tenantDB(t *testing.T, tenant string) *sql.DB {
	t.Helper()
	db, err := sql.Open("pgx", withTenantOption(appURL(t), tenant))
	if err != nil {
		t.Fatalf("open pool for %s: %v", tenant, err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// maintenanceDB is the deliberately cross-tenant session. Fixtures use it
// because creating the second tenant is exactly the operation a tenant-scoped
// session must not be able to perform.
func maintenanceDB(t *testing.T) *sql.DB {
	t.Helper()
	url := appURL(t)
	separator := "?"
	if strings.Contains(url, "?") {
		separator = "&"
	}
	db, err := sql.Open("pgx", url+separator+"options="+
		"-c%20rhinoq.maintenance%3Don")
	if err != nil {
		t.Fatalf("open maintenance pool: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func makeTenant(t *testing.T, id, slug string) {
	t.Helper()
	admin := maintenanceDB(t)
	if _, err := admin.Exec(`
		INSERT INTO rhinoq_tenants (id, slug, name)
		VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, id, slug, slug); err != nil {
		t.Fatalf("create tenant %s: %v", id, err)
	}
}

func insertTask(t *testing.T, db *sql.DB, id string) error {
	t.Helper()
	_, err := db.Exec(`
		INSERT INTO rhinoq_tasks
			(id, type, owner_id, definition_version, state, version, created_at, updated_at)
		VALUES ($1, 'export', 'customer-1', 1, 'pending', 1, now(), now())`, id)
	return err
}

// The headline claim. A row written by one tenant must not be visible to
// another, through any of the four statements that can reach it.
func TestTenantCannotSeeAnotherTenantsTask(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	truncate(t)
	makeTenant(t, "tnt_a", "tenant-a")
	makeTenant(t, "tnt_b", "tenant-b")
	t.Cleanup(func() { truncate(t) })

	alpha := tenantDB(t, "tnt_a")
	beta := tenantDB(t, "tnt_b")

	if err := insertTask(t, alpha, "task_alpha"); err != nil {
		t.Fatalf("tenant A could not create its own task: %v", err)
	}

	var seen int
	if err := beta.QueryRow(
		`SELECT count(*) FROM rhinoq_tasks WHERE id = 'task_alpha'`).Scan(&seen); err != nil {
		t.Fatalf("tenant B select failed unexpectedly: %v", err)
	}
	if seen != 0 {
		t.Fatal("tenant B can SELECT tenant A's task")
	}

	// UPDATE and DELETE are separate paths through the policy. A row invisible
	// to SELECT but reachable by UPDATE would still be a cross-tenant write.
	result, err := beta.Exec(`UPDATE rhinoq_tasks SET state = 'cancelled' WHERE id = 'task_alpha'`)
	if err != nil {
		t.Fatalf("tenant B update errored rather than matching nothing: %v", err)
	}
	if affected, _ := result.RowsAffected(); affected != 0 {
		t.Fatalf("tenant B updated %d of tenant A's tasks", affected)
	}

	result, err = beta.Exec(`DELETE FROM rhinoq_tasks WHERE id = 'task_alpha'`)
	if err != nil {
		t.Fatalf("tenant B delete errored rather than matching nothing: %v", err)
	}
	if affected, _ := result.RowsAffected(); affected != 0 {
		t.Fatalf("tenant B deleted %d of tenant A's tasks", affected)
	}

	// And the row is still there, which is the difference between "isolated"
	// and "silently destroyed".
	var survives int
	if err := alpha.QueryRow(
		`SELECT count(*) FROM rhinoq_tasks WHERE id = 'task_alpha'`).Scan(&survives); err != nil {
		t.Fatalf("tenant A re-read failed: %v", err)
	}
	if survives != 1 {
		t.Fatal("tenant A's task did not survive tenant B's attempts")
	}
}

// WITH CHECK is the half of the policy that is easy to leave out. Without it,
// anything a tenant can see it can also push into another tenant.
func TestTenantCannotWriteIntoAnotherTenant(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	truncate(t)
	makeTenant(t, "tnt_a", "tenant-a")
	makeTenant(t, "tnt_b", "tenant-b")
	t.Cleanup(func() { truncate(t) })

	alpha := tenantDB(t, "tnt_a")

	// Naming another tenant on INSERT.
	_, err := alpha.Exec(`
		INSERT INTO rhinoq_tasks
			(id, tenant_id, type, definition_version, state, version, created_at, updated_at)
		VALUES ('task_planted', 'tnt_b', 'export', 1, 'pending', 1, now(), now())`)
	if err == nil {
		t.Fatal("tenant A inserted a row into tenant B")
	}
	if !strings.Contains(err.Error(), "row-level security") {
		t.Fatalf("insert was refused for the wrong reason: %v", err)
	}

	// Moving one of its own rows across the boundary.
	if err := insertTask(t, alpha, "task_alpha"); err != nil {
		t.Fatalf("tenant A could not create its own task: %v", err)
	}
	_, err = alpha.Exec(`UPDATE rhinoq_tasks SET tenant_id = 'tnt_b' WHERE id = 'task_alpha'`)
	if err == nil {
		t.Fatal("tenant A moved its own row into tenant B")
	}
	if !strings.Contains(err.Error(), "row-level security") {
		t.Fatalf("update was refused for the wrong reason: %v", err)
	}
}

// A session that never announced a tenant is the shape of a misconfigured
// deployment or a background job that forgot. It must read nothing and write
// nothing rather than defaulting to anything.
func TestSessionWithoutATenantIsInert(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	truncate(t)
	makeTenant(t, "tnt_a", "tenant-a")
	t.Cleanup(func() { truncate(t) })

	alpha := tenantDB(t, "tnt_a")
	if err := insertTask(t, alpha, "task_alpha"); err != nil {
		t.Fatalf("tenant A could not create its own task: %v", err)
	}

	// Same role as the runtime, no tenant announced. Opening this as the owner
	// would prove nothing, since the owner is exempt from the policy.
	anonymous, err := sql.Open("pgx", appURL(t))
	if err != nil {
		t.Fatalf("open anonymous pool: %v", err)
	}
	defer anonymous.Close()

	var seen int
	if err := anonymous.QueryRow(`SELECT count(*) FROM rhinoq_tasks`).Scan(&seen); err != nil {
		t.Fatalf("anonymous select errored rather than returning nothing: %v", err)
	}
	if seen != 0 {
		t.Fatalf("a session with no tenant read %d rows", seen)
	}

	// The tenant_id default resolves to NULL, so this trips the NOT NULL
	// constraint from migration 026 before the policy is even consulted. Two
	// independent reasons to fail is the intent, not redundancy.
	if err := insertTask(t, anonymous, "task_anon"); err == nil {
		t.Fatal("a session with no tenant inserted a task")
	}
}

// Row-level security filters rows. It does not stop a child row from being
// attached to a parent in another tenant, because from the writer's side both
// ids are just strings. That is what the composite foreign key in migration
// 026 is for, and this test is the reason it exists.
func TestExecutionCannotAttachToAnotherTenantsTask(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	truncate(t)
	makeTenant(t, "tnt_a", "tenant-a")
	makeTenant(t, "tnt_b", "tenant-b")
	t.Cleanup(func() { truncate(t) })

	alpha := tenantDB(t, "tnt_a")
	beta := tenantDB(t, "tnt_b")

	if err := insertTask(t, alpha, "task_alpha"); err != nil {
		t.Fatalf("tenant A could not create its own task: %v", err)
	}

	// Tenant B knows the id — assume it leaked through a log or a URL — and
	// tries to hang an Execution off it. The insert is well-formed and the
	// tenant_id it writes is B's own, so no policy is violated. Only the
	// composite key stops it.
	_, err := beta.Exec(`
		INSERT INTO rhinoq_task_executions
			(id, task_id, attempt, runtime, state, version, created_at, updated_at)
		VALUES ('exec_planted', 'task_alpha', 1, 'bullmq', 'pending_dispatch', 1, now(), now())`)
	if err == nil {
		t.Fatal("tenant B attached an execution to tenant A's task")
	}
	if !strings.Contains(err.Error(), "rhinoq_task_executions_task_tenant_fkey") {
		t.Fatalf("the insert failed for the wrong reason: %v", err)
	}
}

// Queue controls were keyed by name alone before migration 026, so "pause the
// exports queue" was a global action for every tenant using that name.
func TestPausingAQueueIsScopedToOneTenant(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	truncate(t)
	makeTenant(t, "tnt_a", "tenant-a")
	makeTenant(t, "tnt_b", "tenant-b")
	t.Cleanup(func() { truncate(t) })

	alpha := tenantDB(t, "tnt_a")
	beta := tenantDB(t, "tnt_b")

	for _, db := range []*sql.DB{alpha, beta} {
		if _, err := db.Exec(`
			INSERT INTO rhinoq_queue_controls (queue_name) VALUES ('exports')`); err != nil {
			t.Fatalf("create queue control: %v", err)
		}
	}

	if _, err := alpha.Exec(`
		UPDATE rhinoq_queue_controls SET paused_at = now() WHERE queue_name = 'exports'`); err != nil {
		t.Fatalf("tenant A pause: %v", err)
	}

	var pausedForB sql.NullTime
	if err := beta.QueryRow(`
		SELECT paused_at FROM rhinoq_queue_controls WHERE queue_name = 'exports'`).
		Scan(&pausedForB); err != nil {
		t.Fatalf("tenant B read: %v", err)
	}
	if pausedForB.Valid {
		t.Fatal("tenant A paused tenant B's queue of the same name")
	}
}

// A credential is bound to a membership, so revoking the membership must take
// the credential with it. A credential outliving its grant is an access path
// nobody is looking at any more.
func TestRevokingMembershipRemovesItsCredentials(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	makeTenant(t, "tnt_a", "tenant-a")
	admin := maintenanceDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	t.Cleanup(func() {
		_, _ = admin.Exec(`DELETE FROM rhinoq_principals WHERE id = 'prn_test'`)
	})

	if _, err := admin.ExecContext(ctx, `
		INSERT INTO rhinoq_principals (id, kind, display_name)
		VALUES ('prn_test', 'user', 'Test Person')
		ON CONFLICT (id) DO NOTHING`); err != nil {
		t.Fatalf("create principal: %v", err)
	}
	if _, err := admin.ExecContext(ctx, `
		INSERT INTO rhinoq_memberships (principal_id, tenant_id, role)
		VALUES ('prn_test', 'tnt_a', 'operator')
		ON CONFLICT DO NOTHING`); err != nil {
		t.Fatalf("create membership: %v", err)
	}
	if _, err := admin.ExecContext(ctx, `
		INSERT INTO rhinoq_credentials (id, principal_id, tenant_id, token_sha256)
		VALUES ('cred_test', 'prn_test', 'tnt_a', sha256('a-token'::bytea))`); err != nil {
		t.Fatalf("create credential: %v", err)
	}

	if _, err := admin.ExecContext(ctx, `
		DELETE FROM rhinoq_memberships WHERE principal_id = 'prn_test' AND tenant_id = 'tnt_a'`); err != nil {
		t.Fatalf("revoke membership: %v", err)
	}

	var remaining int
	if err := admin.QueryRowContext(ctx, `
		SELECT count(*) FROM rhinoq_credentials WHERE id = 'cred_test'`).Scan(&remaining); err != nil {
		t.Fatalf("count credentials: %v", err)
	}
	if remaining != 0 {
		t.Fatal("a credential survived the membership that authorised it")
	}
}

// An upgrade-safety invariant, not a feature. Every tenant_id column is NOT
// NULL, so if any of them lacks a default then the first INSERT from a binary
// that predates this change fails — turning `rhinoq migrate apply` into an
// outage rather than an expand-compatible step. docs/migration-rollback.md
// promises the upgrade is safe with the connection option in place; this is
// what makes that promise checkable.
func TestEveryTenantColumnDefaultsToTheSessionTenant(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	rows, err := adminDB.QueryContext(ctx, `
		SELECT c.table_name, coalesce(c.column_default, '')
		FROM information_schema.columns c
		WHERE c.table_schema = 'public'
		  AND c.column_name = 'tenant_id'
		  AND c.is_nullable = 'NO'
		ORDER BY c.table_name`)
	if err != nil {
		t.Fatalf("read column defaults: %v", err)
	}
	defer rows.Close()

	checked := 0
	for rows.Next() {
		var table, columnDefault string
		if err := rows.Scan(&table, &columnDefault); err != nil {
			t.Fatalf("scan: %v", err)
		}
		checked++
		// The identity tables are written explicitly by the membership code
		// and never inherit a tenant, so they are allowed to have no default.
		if table == "rhinoq_memberships" || table == "rhinoq_credentials" {
			continue
		}
		if !strings.Contains(columnDefault, "rhinoq_current_tenant()") {
			t.Fatalf("%s.tenant_id is NOT NULL with default %q; "+
				"an INSERT that omits tenant_id fails, which breaks the upgrade path",
				table, columnDefault)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate: %v", err)
	}
	if checked == 0 {
		t.Fatal("no tenant_id columns found; the query is wrong, not the schema")
	}
}

// The guard that makes all of the above trustworthy in a real deployment.
// Everything else here proves isolation holds for an unprivileged role; this
// proves RhinoQ notices when it has not been given one.
func TestIsolationGuardCatchesAnExemptRole(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// The owner pool is the superuser the official postgres image hands out,
	// which is exactly the configuration an adopter is most likely to run.
	report, err := postgres.InspectTenantIsolation(ctx, adminDB)
	if err != nil {
		t.Fatalf("inspect owner connection: %v", err)
	}
	if report.Holds() {
		t.Fatal("the guard reported isolation as in force for a superuser connection")
	}
	if !report.Exempt {
		t.Fatalf("the guard did not flag the role as exempt: %+v", report)
	}
	if !strings.Contains(report.Explain(), "NOSUPERUSER") {
		t.Fatalf("the explanation does not say how to fix it: %q", report.Explain())
	}
	if err := postgres.RequireTenantIsolation(ctx, adminDB); err == nil {
		t.Fatal("the startup guard admitted a connection with no isolation")
	} else if !errors.Is(err, postgres.ErrTenantIsolationOff) {
		t.Fatalf("the guard failed for the wrong reason: %v", err)
	}

	// And the connection the runtime is meant to use passes.
	if err := postgres.RequireTenantIsolation(ctx, testDB); err != nil {
		t.Fatalf("the guard rejected a correctly configured connection: %v", err)
	}
}

// The database refuses a task_owner grant with no subject scope, so an
// end-user credential cannot be widened to the whole tenant by a bad INSERT
// even if the Go constructor is bypassed.
func TestDatabaseRefusesUnscopedTaskOwnerMembership(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	makeTenant(t, "tnt_a", "tenant-a")
	admin := maintenanceDB(t)
	t.Cleanup(func() {
		_, _ = admin.Exec(`DELETE FROM rhinoq_principals WHERE id = 'prn_enduser'`)
	})

	if _, err := admin.Exec(`
		INSERT INTO rhinoq_principals (id, kind, display_name)
		VALUES ('prn_enduser', 'end_user', 'Browser') ON CONFLICT (id) DO NOTHING`); err != nil {
		t.Fatalf("create principal: %v", err)
	}

	_, err := admin.Exec(`
		INSERT INTO rhinoq_memberships (principal_id, tenant_id, role, owner_scope)
		VALUES ('prn_enduser', 'tnt_a', 'task_owner', '   ')`)
	if err == nil {
		t.Fatal("the database accepted an unscoped task_owner membership")
	}
	var pgErr interface{ SQLState() string }
	if errors.As(err, &pgErr) && pgErr.SQLState() != "23514" {
		t.Fatalf("refused with %s, want a check-constraint violation", pgErr.SQLState())
	}
}
