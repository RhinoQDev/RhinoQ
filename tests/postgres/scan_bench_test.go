package postgres_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

// The benchmarks in tests/benchmarks measure domain functions at nanosecond
// scale, where RhinoQ has never been slow. The cost that matters is here: the
// bookkeeping a scan does per observed subject, against a real PostgreSQL.
//
// Measured before batching, a page of 500 subjects cost about six network round
// trips per subject — a read and a write for the materialized outcome, plus a
// transaction, an advisory lock, a SELECT ... FOR UPDATE and a rollback to
// discover that a passing subject had no Finding to resolve. That is the
// regression this file exists to catch, and no in-memory benchmark can see it.
//
//	docker compose -f tests/postgres/docker-compose.yml up -d
//	cd tests/postgres
//	RHINOQ_TEST_DATABASE_URL=postgres://rhinoq:rhinoq@localhost:55432/rhinoq \
//	  go test -run '^$' -bench BenchmarkScan -benchtime 1x .
//
// ns/op is per subject: the loop evaluates one full page and the benchmark
// divides by the number of subjects in it.

const benchmarkSubjects = 2000

func benchmarkRuleFixture(b *testing.B, violatedEvery int) {
	b.Helper()
	if _, err := testDB.Exec(fmt.Sprintf(`
		DROP TABLE IF EXISTS rhinoq_scan_bench_orders;
		CREATE TABLE rhinoq_scan_bench_orders (
			id bigint PRIMARY KEY,
			status text NOT NULL,
			created_at timestamptz NOT NULL
		);
		CREATE INDEX rhinoq_scan_bench_created_idx
			ON rhinoq_scan_bench_orders (created_at, status);
		INSERT INTO rhinoq_scan_bench_orders (id, status, created_at)
		SELECT number,
		       CASE WHEN number %% %d = 0 THEN 'stuck' ELSE 'provisioned' END,
		       now() - number * interval '1 second'
		FROM generate_series(1, %d) AS number;
		ANALYZE rhinoq_scan_bench_orders`,
		violatedEvery, benchmarkSubjects,
	)); err != nil {
		b.Fatalf("create benchmark fixture: %v", err)
	}
}

// benchmarkScan runs one full scan per iteration and reports the per-subject
// cost. violatedEvery controls how much of the page is drift: a healthy system
// is nearly all passes, which is exactly the case the old code paid most for.
func benchmarkScan(b *testing.B, violatedEvery int) {
	if testDB == nil {
		b.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	ctx := context.Background()
	benchmarkRuleFixture(b, violatedEvery)

	integrity, err := rhinoq.NewIntegrity(testDB)
	if err != nil {
		b.Fatalf("build integrity client: %v", err)
	}
	definition := rhinoq.RuleDefinition{
		ID: "scan-benchmark", Name: "Scan benchmark",
		Scope: rhinoq.RuleScopeTable, SubjectType: "order",
		Query: `SELECT lpad(id::text, 12, '0') AS subject_id,
			status = 'stuck' AS violated,
			jsonb_build_object('status', status) AS evidence
			FROM rhinoq_scan_bench_orders
			WHERE created_at >= $1 AND lpad(id::text, 12, '0') > $2
			ORDER BY lpad(id::text, 12, '0') LIMIT $3`,
		BaselineAt: time.Now().Add(-24 * time.Hour),
		Every:      time.Hour,
		MaxRows:    500,
	}
	if _, err := integrity.RegisterRule(ctx, definition); err != nil {
		b.Fatalf("register rule: %v", err)
	}
	if _, explanation, err := integrity.EnableRule(ctx, definition.ID); err != nil {
		b.Fatalf("enable rule: explanation=%+v err=%v", explanation, err)
	}

	b.ResetTimer()
	for b.Loop() {
		cursor := ""
		observed := 0
		for {
			evaluation, err := integrity.EvaluateRule(ctx, definition.ID, "", cursor)
			if err != nil {
				b.Fatalf("evaluate: %v", err)
			}
			observed += len(evaluation.Observations)
			if !evaluation.HasMore || evaluation.NextCursor == "" {
				break
			}
			cursor = evaluation.NextCursor
		}
		if observed != benchmarkSubjects {
			b.Fatalf("scan must observe every subject, got %d", observed)
		}
	}
	b.StopTimer()

	// ns/op is meaningless per iteration here — one iteration is a whole scan.
	// Reporting per subject is what makes a regression legible.
	b.ReportMetric(
		float64(b.Elapsed().Nanoseconds())/float64(b.N*benchmarkSubjects)/1e6,
		"ms/subject",
	)
}

// BenchmarkScanHealthy is the shape a running system actually has: drift is
// rare, and almost every subject is a pass with no Finding attached.
func BenchmarkScanHealthy(b *testing.B) {
	truncateForBenchmark(b)
	benchmarkScan(b, benchmarkSubjects+1)
}

// BenchmarkScanHalfViolated keeps the Finding write path honest. It is not a
// realistic ratio; it is the upper bound on what a page can cost.
func BenchmarkScanHalfViolated(b *testing.B) {
	truncateForBenchmark(b)
	benchmarkScan(b, 2)
}

func truncateForBenchmark(b *testing.B) {
	b.Helper()
	if testDB == nil {
		return
	}
	if _, err := testDB.Exec(`
		TRUNCATE rhinoq_finding_events, rhinoq_findings,
		         rhinoq_subject_outcomes, rhinoq_rule_schedules,
		         rhinoq_rule_explanations, rhinoq_rules CASCADE`); err != nil {
		b.Fatalf("reset benchmark state: %v", err)
	}
}
