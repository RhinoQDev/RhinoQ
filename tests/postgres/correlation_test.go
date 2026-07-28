package postgres_test

import (
	"context"
	"testing"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

// The no-cutover case end to end: a team running BullMQ records what its worker
// did to the outside world, and reads it back by business subject. No RhinoQ
// job exists at any point, which is the entire reason the correlation model
// exists - the Effect Ledger used to require one.
func TestExternalExecutionRecordsEffectsWithoutARhinoQJob(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	truncate(t)

	integrity, err := rhinoq.NewIntegrity(testDB)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	subject := rhinoq.SubjectRef{Type: "report", ID: "report_3912"}

	stored, err := integrity.RecordExternalEffect(ctx, rhinoq.ExternalEffectRequest{
		Execution:      rhinoq.ExecutionRef{SourceSystem: "bullmq", SourceID: "job_8291"},
		Subject:        subject,
		BusinessKey:    "report_3912",
		Name:           "upload-report",
		IdempotencyKey: "report_3912:pdf",
		ExternalRef:    "reports/report_3912.pdf",
	})
	if err != nil {
		t.Fatalf("an external execution must be able to record an effect: %v", err)
	}
	if stored.JobID != "" {
		t.Fatalf("an external effect has no RhinoQ job: %+v", stored)
	}
	if stored.SourceSystem != "bullmq" || stored.SourceID != "job_8291" {
		t.Fatalf("the execution reference must be preserved: %+v", stored)
	}
	if stored.LeaseEpoch != 0 {
		t.Fatalf("nothing leased this execution, so there is no epoch to record: %+v", stored)
	}

	// Recording the same effect twice returns the first entry. This is the only
	// guarantee available without a lease, and it is the one an external caller
	// can actually provide.
	repeat, err := integrity.RecordExternalEffect(ctx, rhinoq.ExternalEffectRequest{
		Execution:      rhinoq.ExecutionRef{SourceSystem: "bullmq", SourceID: "job_8291"},
		Subject:        subject,
		Name:           "upload-report",
		IdempotencyKey: "report_3912:pdf",
	})
	if err != nil {
		t.Fatal(err)
	}
	if repeat.ID != stored.ID {
		t.Fatalf("the same execution and key must fold into one entry: %s vs %s", repeat.ID, stored.ID)
	}

	// A different execution touching the same subject is a different entry:
	// two runs really did happen, and the ledger must be able to say so.
	second, err := integrity.RecordExternalEffect(ctx, rhinoq.ExternalEffectRequest{
		Execution:      rhinoq.ExecutionRef{SourceSystem: "bullmq", SourceID: "job_9002"},
		Subject:        subject,
		Name:           "upload-report",
		IdempotencyKey: "report_3912:pdf",
	})
	if err != nil {
		t.Fatal(err)
	}
	if second.ID == stored.ID {
		t.Fatal("two distinct executions must not collapse into one ledger entry")
	}

	// The read half: an operator asks about a report, not about a job.
	timeline, err := integrity.SubjectEffects(ctx, subject, 0, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(timeline) != 2 {
		t.Fatalf("expected both executions on the subject timeline, got %d", len(timeline))
	}

	var jobs int
	if err := testDB.QueryRow(`SELECT count(*) FROM rhinoq_jobs`).Scan(&jobs); err != nil {
		t.Fatal(err)
	}
	if jobs != 0 {
		t.Fatalf("the no-cutover path must create no jobs, found %d", jobs)
	}
}

// A RhinoQ execution must not take the unfenced path. The runtime has a lease
// that can refuse a write from a worker which already lost its job, and quietly
// accepting an unfenced write for it would throw that away.
func TestRhinoQExecutionIsRefusedOnTheUnfencedPath(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	truncate(t)

	integrity, err := rhinoq.NewIntegrity(testDB)
	if err != nil {
		t.Fatal(err)
	}
	_, err = integrity.RecordExternalEffect(context.Background(), rhinoq.ExternalEffectRequest{
		Execution:      rhinoq.ExecutionRef{SourceSystem: "rhinoq", SourceID: "job_000001"},
		Subject:        rhinoq.SubjectRef{Type: "report", ID: "report_1"},
		Name:           "upload-report",
		IdempotencyKey: "report_1:pdf",
	})
	if err == nil {
		t.Fatal("a RhinoQ execution must record its effects through the fenced runtime path")
	}
}

// An execution reference needs both halves, and a subject needs both halves.
// Half an identifier cannot be looked up or disambiguated later.
func TestCorrelationRefusesHalfAnIdentifier(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	truncate(t)

	integrity, err := rhinoq.NewIntegrity(testDB)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	for name, request := range map[string]rhinoq.ExternalEffectRequest{
		"execution without a source id": {
			Execution:      rhinoq.ExecutionRef{SourceSystem: "bullmq"},
			Name:           "upload-report",
			IdempotencyKey: "k",
		},
		"execution without a source system": {
			Execution:      rhinoq.ExecutionRef{SourceID: "job_1"},
			Name:           "upload-report",
			IdempotencyKey: "k",
		},
		"subject type without an id": {
			Execution:      rhinoq.ExecutionRef{SourceSystem: "bullmq", SourceID: "job_1"},
			Subject:        rhinoq.SubjectRef{Type: "report"},
			Name:           "upload-report",
			IdempotencyKey: "k",
		},
	} {
		if _, err := integrity.RecordExternalEffect(ctx, request); err == nil {
			t.Errorf("%s must be refused", name)
		}
	}
}
