package postgres_test

import (
	"context"
	"errors"
	"testing"

	"github.com/rhinoq/rhinoq/pkg/rhinoq"
)

func TestDeveloperInspectionReadsJobEffectAndOutcomeEvidence(t *testing.T) {
	client := newClient(t)
	ctx := context.Background()
	id := enqueue(t, client, rhinoq.JobRequest{
		Name: "generate-report", Payload: []byte("{}"),
		CorrelationID: "report_01",
	})
	leased := claimOne(t, client, "reports-1")
	request := rhinoq.EffectRequest{
		Name: "upload-report", Key: "report_01:pdf",
		Confirm: rhinoq.ConfirmOnReturn,
	}
	if _, err := client.BeginEffect(ctx, leased.Lease, request); err != nil {
		t.Fatal(err)
	}
	if _, err := client.ResolveEffect(
		ctx, leased.Lease, request, "reports/report_01.pdf",
		rhinoq.EffectSucceeded,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := testDB.ExecContext(ctx, `
		INSERT INTO rhinoq_outcomes
			(id, job_id, contract_version, state, reason, observed_version)
		VALUES
			('out_report_01', $1, 2, 'achieved', 'output object exists', 17)`, id); err != nil {
		t.Fatal(err)
	}

	job, err := client.GetJob(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if job.CorrelationID != "report_01" {
		t.Fatalf("unexpected job summary: %+v", job)
	}
	effects, err := client.ListEffectEvidence(ctx, id, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(effects) != 1 || effects[0].State != rhinoq.EffectConfirmed ||
		effects[0].ExternalRef != "reports/report_01.pdf" {
		t.Fatalf("unexpected effect evidence: %+v", effects)
	}
	outcomes, err := client.ListOutcomeEvidence(ctx, id, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(outcomes) != 1 || outcomes[0].State != "achieved" ||
		outcomes[0].ContractVersion != 2 {
		t.Fatalf("unexpected outcome evidence: %+v", outcomes)
	}
}

func TestDeveloperInspectionReportsMissingJob(t *testing.T) {
	client := newClient(t)
	_, err := client.GetJob(context.Background(), "job_missing")
	if !errors.Is(err, rhinoq.ErrJobNotFound) {
		t.Fatalf("expected ErrJobNotFound, got %v", err)
	}
}
