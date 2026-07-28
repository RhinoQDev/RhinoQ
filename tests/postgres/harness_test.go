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
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/rhinoq/rhinoq/internal/adapters/postgres"
	"github.com/rhinoq/rhinoq/internal/ports"
	"github.com/rhinoq/rhinoq/pkg/rhinoq"
)

var testDB *sql.DB

func TestMain(m *testing.M) {
	url := os.Getenv("RHINOQ_TEST_DATABASE_URL")
	if url == "" {
		// Nothing to run against. Individual tests report the skip so the
		// reason is visible in the output.
		os.Exit(m.Run())
	}
	db, err := sql.Open("pgx", url)
	if err != nil {
		panic("open test database: " + err.Error())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		panic("the test database is not reachable: " + err.Error())
	}
	if err := applyMigrations(db); err != nil {
		panic(err.Error())
	}
	testDB = db
	code := m.Run()
	_ = db.Close()
	os.Exit(code)
}

// applyMigrations runs every migration in order, the same way an operator is
// told to. A harness that builds its schema by hand would not catch a broken
// migration, which is the failure that actually reaches production.
func applyMigrations(db *sql.DB) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()

	// Production roles often prepend an application schema. Run migrations
	// under that hostile search_path so every authoritative table has to choose
	// its schema explicitly; otherwise a later migration may silently create a
	// second rhinoq_jobs in the wrong namespace.
	if _, err := conn.ExecContext(ctx, `
		CREATE SCHEMA IF NOT EXISTS rhinoq;
		SET search_path = rhinoq, public`); err != nil {
		return migrationError{file: "search_path", err: err}
	}

	pattern := filepath.Join("..", "..", "internal", "infrastructure", "migrations", "*.sql")
	files, err := filepath.Glob(pattern)
	if err != nil {
		return err
	}
	if len(files) == 0 {
		return errNoMigrations
	}
	sort.Strings(files)
	for _, file := range files {
		statements, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		if _, err := conn.ExecContext(ctx, string(statements)); err != nil {
			return migrationError{file: filepath.Base(file), err: err}
		}
	}
	return validateSchemaLayout(ctx, conn)
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

var errNoMigrations = migrationError{file: "migrations", err: errString("no migration files found")}

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
	_, err := testDB.Exec(`
		TRUNCATE rhinoq_rule_explanations, rhinoq_rules,
		         rhinoq_finding_events, rhinoq_findings,
		         rhinoq_audit, rhinoq_attempt_events, rhinoq_effects, rhinoq_outcomes, rhinoq_outbox,
		         rhinoq_jobs, rhinoq_queue_controls RESTART IDENTITY CASCADE`)
	if err != nil {
		t.Fatalf("reset tables: %v", err)
	}
	if _, err := testDB.Exec(`TRUNCATE rhinoq.job_allowlist`); err != nil {
		t.Fatalf("reset allowlist: %v", err)
	}
}

func enqueue(t *testing.T, client *rhinoq.Client, request rhinoq.JobRequest) string {
	t.Helper()
	id, err := client.Enqueue(context.Background(), request)
	if err != nil {
		t.Fatalf("enqueue %s: %v", request.Name, err)
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
	jobs, err := client.ListJobs(context.Background(), rhinoq.JobQuery{Queue: queue, Limit: 200})
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
