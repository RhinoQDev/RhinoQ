package postgres_test

import (
	"context"
	"fmt"
	"testing"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

// Benchmarks shaped like the workload a design partner actually brings, rather
// than like a function RhinoQ happens to expose.
//
// docs/design-partners.md defines seat A as "import, export, media or AI batch
// with at least 100 items" and states the proof RhinoQ must produce for it:
// *Task summary polling stays bounded*. That sentence is a performance claim
// with a shape — summary cost must not grow with fan-out — and until something
// measures it at several fan-out sizes it is an assertion.
//
// So these do not report a throughput number to put in a README. They report
// the same operation at 100, 1,000 and 5,000 executions, which is the only
// form in which "bounded" can be true or false.
//
//	docker compose -f tests/postgres/docker-compose.yml up -d
//	cd tests/postgres
//	RHINOQ_TEST_DATABASE_URL=postgres://rhinoq:rhinoq@localhost:55432/rhinoq \
//	  go test -run '^$' -bench BenchmarkAdopter -benchtime 20x .
//
// WHAT THESE NUMBERS ARE NOT
//
// One machine, one PostgreSQL container, synthetic rows. They are a regression
// tripwire for this repository, not a measurement of any adopter's system. The
// benchmark against a real adopter workload named in docs/adoption-gap.md
// still requires a real adopter; nothing here substitutes for it.

var fanOutSizes = []int{100, 1000, 5000}

// buildFanOut creates one Task with the given number of executions, which is
// the shape of a batch job: one thing the user is watching, many things being
// done underneath it.
func buildFanOut(b *testing.B, taskID string, executions int) {
	b.Helper()
	if testDB == nil {
		b.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	ctx := context.Background()
	if _, err := testDB.ExecContext(ctx, `
		INSERT INTO rhinoq_tasks
			(id, type, owner_id, definition_version, state, version, created_at, updated_at)
		VALUES ($1, 'batch', 'bench-owner', 1, 'running', 1, now(), now())
		ON CONFLICT (id) DO NOTHING`, taskID); err != nil {
		b.Fatalf("create task: %v", err)
	}
	// generate_series rather than a Go loop: the setup is not what is being
	// measured, and 5,000 round trips per benchmark would dominate the run.
	// external_id is not decoration: the schema refuses a non-native execution
	// that has reached a terminal state without one, because an Execution that
	// ran somewhere and cannot say where is not evidence of anything. Giving
	// each row a BullMQ-shaped id keeps the fixture the same shape as the
	// workload being modelled.
	if _, err := testDB.ExecContext(ctx, `
		INSERT INTO rhinoq_task_executions
			(id, task_id, attempt, runtime, external_id, state, version, created_at, updated_at)
		SELECT $1 || '_exec_' || n, $1, n, 'bullmq', 'bull:batch:' || n,
		       CASE WHEN n % 7 = 0 THEN 'failed' ELSE 'succeeded' END,
		       1, now(), now()
		FROM generate_series(1, $2) AS n
		ON CONFLICT (id) DO NOTHING`, taskID, executions); err != nil {
		b.Fatalf("create executions: %v", err)
	}
	// The aggregate columns from migration 020 are what makes the summary
	// bounded. Setting them here mirrors what the write path maintains in the
	// same transaction as an Execution write; the check constraint on the
	// table refuses any split that does not add up, so this cannot drift into
	// measuring an impossible state.
	// $2 is cast explicitly: without it PostgreSQL sees the same parameter used
	// as bigint on the left of the assignment and in integer division on the
	// right, and refuses to deduce one type for it.
	if _, err := testDB.ExecContext(ctx, `
		UPDATE rhinoq_tasks
		SET execution_total = $2::bigint,
		    execution_succeeded = $2::bigint - ($2::bigint / 7),
		    execution_failed = $2::bigint / 7
		WHERE id = $1`, taskID, executions); err != nil {
		b.Fatalf("set aggregate counts: %v", err)
	}
	// Without this the benchmark measures a planner that thinks the table holds
	// twelve rows, because nothing has looked at it since the bulk insert. The
	// plan it picks under that belief — bitmap scan, then sort everything — is
	// one autovacuum would correct within minutes in a real deployment, so
	// reporting it as RhinoQ's page cost would be measuring the fixture.
	//
	// This cost the first version of this file a wrong conclusion: it reported
	// the page as unbounded and blamed a missing index, when the index was
	// only half the answer.
	if _, err := testDB.ExecContext(ctx, `ANALYZE rhinoq_task_executions`); err != nil {
		b.Fatalf("analyze: %v", err)
	}
}

// benchClient is newClient's benchmark peer. It cannot reuse newClient because
// that takes a *testing.T, and the fixtures it calls report failures through
// it — handing over a nil would turn a setup error into a panic with no
// message.
func benchClient(b *testing.B) *rhinoq.Client {
	b.Helper()
	if testDB == nil {
		b.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	if _, err := adminDB.Exec(
		`TRUNCATE rhinoq_task_executions, rhinoq_tasks RESTART IDENTITY CASCADE`); err != nil {
		b.Fatalf("reset tables: %v", err)
	}
	client, err := rhinoq.NewPostgres(testDB)
	if err != nil {
		b.Fatalf("build client: %v", err)
	}
	return client
}

// The load-bearing one. A browser polls this on a timer for the whole life of
// the batch, so its cost is paid once per poll per open tab. If it grows with
// fan-out, a large job degrades the experience of watching it — which is the
// one thing the product promises to be good at.
func BenchmarkAdopterTaskSummaryPolling(b *testing.B) {
	if testDB == nil {
		b.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	for _, size := range fanOutSizes {
		b.Run(fmt.Sprintf("fanout=%d", size), func(b *testing.B) {
			client := benchClient(b)
			taskID := fmt.Sprintf("bench_summary_%d", size)
			buildFanOut(b, taskID, size)
			ctx := context.Background()

			b.ReportAllocs()
			b.ResetTimer()
			for index := 0; index < b.N; index++ {
				if _, err := client.GetTaskSummary(ctx, taskID); err != nil {
					b.Fatalf("summary at fan-out %d: %v", size, err)
				}
			}
		})
	}
}

// The page read is allowed to cost more than the summary — it returns rows.
// What it must not do is cost more *per page* as the task grows, which is what
// an offset-paginated implementation would do.
func BenchmarkAdopterExecutionPage(b *testing.B) {
	if testDB == nil {
		b.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	for _, size := range fanOutSizes {
		b.Run(fmt.Sprintf("fanout=%d", size), func(b *testing.B) {
			client := benchClient(b)
			taskID := fmt.Sprintf("bench_page_%d", size)
			buildFanOut(b, taskID, size)
			ctx := context.Background()

			b.ReportAllocs()
			b.ResetTimer()
			for index := 0; index < b.N; index++ {
				if _, err := client.ListTaskExecutions(ctx, taskID, "", 50); err != nil {
					b.Fatalf("page at fan-out %d: %v", size, err)
				}
			}
		})
	}
}
