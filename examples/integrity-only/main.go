package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"os"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	databaseURL := os.Getenv("RHINOQ_SUBJECT_DATABASE_URL")
	if databaseURL == "" {
		databaseURL = os.Getenv("RHINOQ_DATABASE_URL")
	}
	if databaseURL == "" {
		log.Fatal("set RHINOQ_SUBJECT_DATABASE_URL before running this example")
	}
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	if err := db.PingContext(ctx); err != nil {
		log.Fatal(err)
	}

	// A nil store keeps Rules and Findings in memory: this example writes to no
	// database at all, so a role with SELECT on the reports table is enough.
	// Pass a second pool - RhinoQ's own database, never the application's - to
	// make Findings survive the process.
	integrity, err := rhinoq.NewDetector(db, nil)
	if err != nil {
		log.Fatal(err)
	}
	const ruleID = "completed-report-has-output"
	enabled, err := integrity.ListRules(ctx, rhinoq.RuleQuery{
		Statuses: []string{rhinoq.RuleEnabled}, Limit: 100,
	})
	if err != nil {
		log.Fatal(err)
	}
	ruleExists := false
	for _, record := range enabled {
		if record.ID == ruleID {
			ruleExists = true
			break
		}
	}
	if !ruleExists {
		registerAndEnableRule(ctx, integrity, ruleID)
	}

	summary, err := integrity.Scan(ctx, rhinoq.ScanRequest{
		RuleID: ruleID, MaxPages: 10,
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf(
		"observed=%d passed=%d violated=%d unknown=%d findings=%d\n",
		summary.Observed, summary.Passed, summary.Violated,
		summary.Unknown, summary.Findings,
	)

	findings, err := integrity.ListFindings(ctx, rhinoq.FindingQuery{
		RuleID: ruleID, Statuses: []string{
			rhinoq.FindingOpen, rhinoq.FindingRegressed,
			rhinoq.FindingAcknowledged,
		}, Limit: 100,
	})
	if err != nil {
		log.Fatal(err)
	}
	for _, finding := range findings {
		fmt.Printf(
			"finding subject=%s status=%s evidence=%s\n",
			finding.SubjectID, finding.Status, finding.LatestEvidence,
		)
	}
}

func registerAndEnableRule(
	ctx context.Context,
	integrity *rhinoq.IntegrityClient,
	ruleID string,
) {
	rule, err := integrity.RegisterRule(ctx, rhinoq.RuleDefinition{
		ID:          ruleID,
		Name:        "Completed reports have an output object",
		Scope:       rhinoq.RuleScopeTable,
		SubjectType: "report",
		Query: `
			SELECT
				id::text AS subject_id,
				CASE
					WHEN status = 'completed' THEN output_key IS NULL
					ELSE false
				END AS violated,
				jsonb_build_object(
					'status', status,
					'outputKey', output_key
				) AS evidence
			FROM public.rhinoq_example_reports
			WHERE updated_at >= $1
			  AND (($4::text = '' AND id::text > $2) OR id::text = $4)
			ORDER BY id::text
			LIMIT $3`,
		BaselineAt:       time.Now().UTC().Add(-24 * time.Hour),
		Every:            10 * time.Minute,
		MaxRows:          100,
		StatementTimeout: 3 * time.Second,
	})
	if err != nil {
		log.Fatal(err)
	}
	if _, explanation, err := integrity.EnableRule(ctx, rule.ID); err != nil {
		log.Fatalf("Rule did not pass Explain: %v; reasons=%v", err, explanation.Reasons)
	}
}
