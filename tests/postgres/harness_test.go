// Package postgres_test runs the RhinoQ storage contract against a real
// PostgreSQL. Everything the engine promises - fencing, ordering, admission,
// rate limiting, poison protection, recovery - is enforced in SQL, and SQL that
// has only been read is not evidence.
//
//	docker compose -f tests/postgres/docker-compose.yml up -d
//	cd tests/postgres
//	RHINOQ_TEST_DATABASE_URL=postgres://rhinoq:rhinoq@localhost:5432/rhinoq \
//	  go test ./...
//
// Without RHINOQ_TEST_DATABASE_URL the package skips, so the engine's own
// `go test ./...` stays hermetic. The harness is a separate Go module because
// it needs a driver, and the engine must stay dependency-free.
package postgres_test

import (
	"context"
	"database/sql"
	neturl "net/url"
	"os"
	"strings"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/madebyduy/RhinoQ/internal/adapters/postgres"
	"github.com/madebyduy/RhinoQ/internal/infrastructure/migrations"
	"github.com/madebyduy/RhinoQ/internal/ports"
	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

var (
	testDB *sql.DB
	// adminDB owns the schema and is used only by fixtures.
	adminDB *sql.DB
)

func TestMain(m *testing.M) {
	url := os.Getenv("RHINOQ_TEST_DATABASE_URL")
	if url == "" {
		// Nothing to run against. Individual tests report the skip so the
		// reason is visible in the output.
		os.Exit(m.Run())
	}
	// Migrations run as the owner. Everything after them runs as an
	// unprivileged role, because PostgreSQL exempts superusers and any role
	// with BYPASSRLS from row-level security — FORCE included. The official
	// postgres image makes POSTGRES_USER a superuser, so a harness that keeps
	// using it would run the entire isolation suite with the policies switched
	// off and report green. That is the failure this line exists to prevent.
	admin, err := sql.Open("pgx", url)
	if err != nil {
		panic("open test database: " + err.Error())
	}
	ctxSetup, cancelSetup := context.WithTimeout(context.Background(), 30*time.Second)
	if err := admin.PingContext(ctxSetup); err != nil {
		panic("the test database is not reachable: " + err.Error())
	}
	if err := applyMigrations(admin); err != nil {
		panic(err.Error())
	}
	if err := provisionApplicationRole(ctxSetup, admin); err != nil {
		panic(err.Error())
	}
	cancelSetup()
	// The owner pool stays open for fixtures only. Resetting tables between
	// tests needs ownership of the sequences, which the application role
	// deliberately does not have — a runtime that can TRUNCATE ... RESTART
	// IDENTITY is a runtime that can erase the audit trail.
	adminDB = admin

	appURL, err := asApplicationRole(url)
	if err != nil {
		panic(err.Error())
	}
	// Every connection in this pool announces its tenant, which is how a
	// single-tenant deployment is meant to be wired: the isolation is a
	// property of the connection, not something each query has to remember.
	// Running the whole existing suite through it is the point — if a tenant
	// predicate is missing anywhere, these tests stop passing.
	db, err := sql.Open("pgx", withTenantOption(appURL, "tnt_system"))
	if err != nil {
		panic("open test database: " + err.Error())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		panic("the test database is not reachable: " + err.Error())
	}
	if err := assertPoliciesApply(ctx, db); err != nil {
		panic(err.Error())
	}
	testDB = db
	code := m.Run()
	_ = db.Close()
	_ = adminDB.Close()
	os.Exit(code)
}

// applyMigrations runs every migration in order, the same way an operator is
// told to. A harness that builds its schema by hand would not catch a broken
// migration, which is the failure that actually reaches production.
func applyMigrations(db *sql.DB) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	runner, err := migrations.NewRunner(db)
	if err != nil {
		return err
	}
	statuses, err := runner.Apply(ctx)
	if err != nil {
		return err
	}
	if migrations.PendingCount(statuses) != 0 {
		return migrationError{
			file: "migration runner",
			err:  errString("runner returned with pending migrations"),
		}
	}
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `
		CREATE SCHEMA IF NOT EXISTS rhinoq;
		SET search_path = rhinoq, public`); err != nil {
		return migrationError{file: "search_path", err: err}
	}
	return validateSchemaLayout(ctx, conn)
}

// applicationRole is what RhinoQ is meant to connect as in a deployment: it
// can read and write the tables and it can do nothing else. Owning nothing and
// holding neither SUPERUSER nor BYPASSRLS is not a detail — those are the two
// attributes that switch row-level security off.
const applicationRole = "rhinoq_app"

func provisionApplicationRole(ctx context.Context, admin *sql.DB) error {
	statements := []string{
		`DO $$
		 BEGIN
		     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhinoq_app') THEN
		         CREATE ROLE rhinoq_app LOGIN PASSWORD 'rhinoq_app'
		             NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
		     END IF;
		 END
		 $$`,
		`GRANT USAGE ON SCHEMA public TO rhinoq_app`,
		// CREATE is a harness concession, not a deployment recommendation: the
		// Rule tests build the adopter's own business tables to scan. A real
		// deployment grants the Rule-reading role SELECT on those tables and
		// nothing more, as docs/postgres.md sets out.
		`GRANT CREATE ON SCHEMA public TO rhinoq_app`,
		`CREATE SCHEMA IF NOT EXISTS rhinoq`,
		`GRANT USAGE ON SCHEMA rhinoq TO rhinoq_app`,
		`GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO rhinoq_app`,
		`GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA rhinoq TO rhinoq_app`,
		`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rhinoq_app`,
		`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO rhinoq_app`,
		`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA rhinoq TO rhinoq_app`,
	}
	for _, statement := range statements {
		if _, err := admin.ExecContext(ctx, statement); err != nil {
			return migrationError{file: "provision " + applicationRole, err: err}
		}
	}
	return nil
}

func asApplicationRole(raw string) (string, error) {
	parsed, err := neturl.Parse(raw)
	if err != nil {
		return "", migrationError{file: "parse database url", err: err}
	}
	parsed.User = neturl.UserPassword(applicationRole, "rhinoq_app")
	return parsed.String(), nil
}

// assertPoliciesApply refuses to run the suite if the connection it was given
// is exempt from row-level security. Every isolation test below would pass
// vacuously against a superuser, so the harness checks the one precondition
// that makes their result mean anything.
func assertPoliciesApply(ctx context.Context, db *sql.DB) error {
	var exempt bool
	if err := db.QueryRowContext(ctx, `
		SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user`).
		Scan(&exempt); err != nil {
		return migrationError{file: "row-level security precondition", err: err}
	}
	if exempt {
		return migrationError{file: "row-level security precondition", err: errString(
			"the harness connected as a role that bypasses row-level security; " +
				"every tenant isolation test would pass without isolating anything",
		)}
	}
	return nil
}

// withTenantOption binds a connection string to one tenant using PostgreSQL's
// `options` parameter, so rhinoq.tenant_id is set by the server at connection
// time. Doing it here rather than with a SET statement after connecting means
// there is no window in which a pooled connection is live without a tenant,
// and no way for a query to run before the SET.
//
// PostgreSQL connection URLs accept one `options` value. Replacing the old
// string concatenation avoids silently discarding an existing option when the
// CI URL already announces tnt_system.
func withTenantOption(rawURL, tenant string) string {
	return withPostgresOption(rawURL, "-c rhinoq.tenant_id="+tenant)
}

func withPostgresOption(rawURL, option string) string {
	parsed, err := neturl.Parse(rawURL)
	if err != nil {
		// The caller already validates the database URL before opening a pool.
		// Preserve the old value here so a malformed URL still produces the
		// useful connection error rather than hiding it behind this helper.
		return rawURL
	}
	query := parsed.Query()
	options := strings.TrimSpace(query.Get("options"))
	if options == "" {
		options = option
	} else {
		options += " " + option
	}
	query.Set("options", options)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func withoutPostgresSetting(rawURL, setting string) string {
	parsed, err := neturl.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	query := parsed.Query()
	tokens := strings.Fields(query.Get("options"))
	kept := make([]string, 0, len(tokens))
	for i := 0; i < len(tokens); i++ {
		if tokens[i] == "-c" && i+1 < len(tokens) &&
			(strings.HasPrefix(tokens[i+1], setting+"=") || tokens[i+1] == setting) {
			i++
			continue
		}
		kept = append(kept, tokens[i])
	}
	if len(kept) == 0 {
		query.Del("options")
	} else {
		query.Set("options", strings.Join(kept, " "))
	}
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func TestWithPostgresOptionPreservesExistingOptions(t *testing.T) {
	rawURL := "postgres://rhinoq:rhinoq@localhost:5432/rhinoq?sslmode=disable&options=-c%20rhinoq.tenant_id%3Dtnt_system"
	got := withPostgresOption(rawURL, "-c rhinoq.maintenance=on")

	parsed, err := neturl.Parse(got)
	if err != nil {
		t.Fatalf("parse rewritten URL: %v", err)
	}
	if options := parsed.Query().Get("options"); options !=
		"-c rhinoq.tenant_id=tnt_system -c rhinoq.maintenance=on" {
		t.Fatalf("options = %q", options)
	}
	if sslmode := parsed.Query().Get("sslmode"); sslmode != "disable" {
		t.Fatalf("sslmode = %q", sslmode)
	}
}

func TestWithoutPostgresSettingPreservesOtherOptions(t *testing.T) {
	rawURL := "postgres://rhinoq:rhinoq@localhost:5432/rhinoq?sslmode=disable&options=-c%20rhinoq.tenant_id%3Dtnt_system"
	got := withoutPostgresSetting(rawURL, "rhinoq.tenant_id")

	parsed, err := neturl.Parse(got)
	if err != nil {
		t.Fatalf("parse rewritten URL: %v", err)
	}
	if options := parsed.Query().Get("options"); options != "" {
		t.Fatalf("options = %q", options)
	}
	if sslmode := parsed.Query().Get("sslmode"); sslmode != "disable" {
		t.Fatalf("sslmode = %q", sslmode)
	}
}

type queryRower interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func validateSchemaLayout(ctx context.Context, query queryRower) error {
	var jobsInPublic, attemptsInPublic, duplicateJobs bool
	err := query.QueryRowContext(ctx, `
		SELECT to_regclass('public.rhinoq_jobs') IS NOT NULL,
		       to_regclass('public.rhinoq_attempt_events') IS NOT NULL,
		       to_regclass('rhinoq.rhinoq_jobs') IS NOT NULL`).
		Scan(&jobsInPublic, &attemptsInPublic, &duplicateJobs)
	if err != nil {
		return migrationError{file: "schema layout", err: err}
	}
	if !jobsInPublic || !attemptsInPublic || duplicateJobs {
		return migrationError{file: "schema layout", err: errString(
			"authoritative tables must exist only in public, even with an application schema first in search_path",
		)}
	}
	return nil
}

type migrationError struct {
	file string
	err  error
}

func (e migrationError) Error() string { return "apply " + e.file + ": " + e.err.Error() }

type errString string

func (e errString) Error() string { return string(e) }

// newClient gives a test an empty queue. The tables are truncated rather than
// recreated so every test still exercises the migrated schema.
func newClient(t *testing.T) *rhinoq.Client {
	t.Helper()
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	truncate(t)
	client, err := rhinoq.NewPostgres(testDB)
	if err != nil {
		t.Fatalf("build client: %v", err)
	}
	return client
}

func truncate(t *testing.T) {
	t.Helper()
	_, err := adminDB.Exec(`
		TRUNCATE rhinoq_notification_deliveries, rhinoq_repairs, rhinoq_provider_operations,
		         rhinoq_task_schedules,
		         rhinoq_task_executions, rhinoq_tasks,
		         rhinoq_subject_changes, rhinoq_subject_outcomes,
		         rhinoq_rule_explanations, rhinoq_rules,
		         rhinoq_finding_events, rhinoq_findings,
		         rhinoq_audit, rhinoq_attempt_events, rhinoq_effects, rhinoq_outcomes, rhinoq_outbox,
		         rhinoq_jobs, rhinoq_queue_controls RESTART IDENTITY CASCADE`)
	if err != nil {
		t.Fatalf("reset tables: %v", err)
	}
	if _, err := adminDB.Exec(`TRUNCATE rhinoq.job_allowlist`); err != nil {
		t.Fatalf("reset allowlist: %v", err)
	}
}

// databaseNow keeps time-sensitive storage contracts aligned with the same
// clock authority used by PostgreSQL comparisons. Fixed calendar fixtures
// eventually expire and make otherwise correct tests depend on the day they
// happen to run.
func databaseNow(t *testing.T) time.Time {
	t.Helper()
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var now time.Time
	if err := testDB.QueryRowContext(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		t.Fatalf("read PostgreSQL clock: %v", err)
	}
	return now.UTC()
}

func enqueue(t *testing.T, client *rhinoq.Client, request rhinoq.JobRequest) string {
	t.Helper()
	id, err := client.Enqueue(context.Background(), request)
	if err != nil {
		t.Fatalf("enqueue %s/%s: %v", request.QueueName, request.JobName, err)
	}
	return id
}

func claim(t *testing.T, client *rhinoq.Client, worker string, limit int, leaseFor time.Duration) []rhinoq.LeasedJob {
	t.Helper()
	jobs, err := client.ClaimJobs(context.Background(), rhinoq.ClaimRequest{
		Worker: worker, Limit: limit, LeaseFor: leaseFor,
	})
	if err != nil {
		t.Fatalf("claim for %s: %v", worker, err)
	}
	return jobs
}

func claimOne(t *testing.T, client *rhinoq.Client, worker string) rhinoq.LeasedJob {
	t.Helper()
	jobs := claim(t, client, worker, 1, time.Minute)
	if len(jobs) != 1 {
		t.Fatalf("expected one claimed job, got %d", len(jobs))
	}
	return jobs[0]
}

func jobState(t *testing.T, client *rhinoq.Client, queue, jobID string) rhinoq.JobSummary {
	t.Helper()
	jobs, err := client.ListJobs(context.Background(), rhinoq.JobQuery{QueueName: queue, Limit: 200})
	if err != nil {
		t.Fatalf("list %s: %v", queue, err)
	}
	for _, job := range jobs {
		if job.ID == jobID {
			return job
		}
	}
	t.Fatalf("job %s not found in queue %s", jobID, queue)
	return rhinoq.JobSummary{}
}

// newJobStore and newEffectStore reach past the public client so a test can
// drive the runtime pieces - the reaper, the ledger - directly against the real
// schema.
func newJobStore() (ports.JobStore, error) { return postgres.NewJobStore(testDB) }

func newEffectStore(t *testing.T) ports.EffectStore {
	t.Helper()
	store, err := postgres.NewEffectStore(testDB)
	if err != nil {
		t.Fatalf("build effect store: %v", err)
	}
	return store
}

// expireLeases moves every live lease into the past so the reaper has something
// to find, without making the test wait for a real timeout.
func expireLeases(t *testing.T) {
	t.Helper()
	if _, err := testDB.Exec(`
		UPDATE rhinoq_jobs SET lease_until = now() - interval '1 second'
		WHERE state = 'leased'`); err != nil {
		t.Fatalf("expire leases: %v", err)
	}
}
