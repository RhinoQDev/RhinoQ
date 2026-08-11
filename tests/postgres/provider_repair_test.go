package postgres_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

func TestProviderOperationPersistsUnknownAndDeduplicatesAcrossClients(t *testing.T) {
	client := newClient(t)
	ctx := context.Background()
	calls := 0
	request := rhinoq.ProviderOperationRequest{Provider: "stripe", Operation: "refund", IdempotencyKey: "pg-refund-1"}
	first, err := client.ProviderOperation(ctx, request, func(context.Context, string) (rhinoq.ProviderAcceptance, error) {
		calls++
		return rhinoq.ProviderAcceptance{}, errors.New("response lost")
	}, nil)
	if err == nil || first.State != "uncertain" || calls != 1 {
		t.Fatalf("first=%+v calls=%d err=%v", first, calls, err)
	}
	attention, err := client.ListProviderOperationsNeedingAttention(ctx, rhinoq.ProviderOperationAttentionQuery{Before: time.Now().UTC().Add(time.Minute), Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range attention {
		if item.ID == first.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("uncertain operation %s missing from reconciliation query: %+v", first.ID, attention)
	}
	secondClient, err := rhinoq.NewPostgres(testDB)
	if err != nil {
		t.Fatal(err)
	}
	second, err := secondClient.ProviderOperation(ctx, request, func(context.Context, string) (rhinoq.ProviderAcceptance, error) {
		calls++
		return rhinoq.ProviderAcceptance{}, nil
	}, func(context.Context, rhinoq.ProviderOperationRecord) (rhinoq.ProviderConfirmation, error) {
		return rhinoq.ProviderConfirmation{Decision: rhinoq.ProviderConfirmed, Evidence: "re_pg:succeeded"}, nil
	})
	if err != nil || second.ID != first.ID || second.State != "confirmed" || calls != 1 {
		t.Fatalf("second=%+v calls=%d err=%v", second, calls, err)
	}
}

type postgresRepairHandler struct {
	precondition string
	applied      int
}

func (h *postgresRepairHandler) Preview(context.Context, rhinoq.FindingKey, json.RawMessage) (rhinoq.RepairPreview, error) {
	return rhinoq.RepairPreview{Summary: "repair row", Precondition: h.precondition}, nil
}
func (h *postgresRepairHandler) Apply(context.Context, rhinoq.FindingKey, json.RawMessage, string) (rhinoq.RepairApplyResult, error) {
	h.applied++
	return rhinoq.RepairApplyResult{Outcome: "updated"}, nil
}
func (h *postgresRepairHandler) Verify(context.Context, rhinoq.FindingKey, json.RawMessage) (rhinoq.RepairVerification, error) {
	return rhinoq.RepairVerification{Passed: true, Evidence: "row valid"}, nil
}

func TestSafeRepairPersistsApprovalAndVerification(t *testing.T) {
	client := newClient(t)
	ctx := context.Background()
	key := rhinoq.FindingKey{RuleID: "pg-repair", SubjectType: "invoice", SubjectID: "inv-pg", InvariantVersion: 1}
	_, err := client.ObserveFinding(ctx, rhinoq.FindingObservation{FindingKey: key, Evidence: "invalid", ObservedAt: time.Now().UTC()})
	if err != nil {
		t.Fatal(err)
	}
	h := &postgresRepairHandler{precondition: "version-1"}
	registry := rhinoq.NewRepairRegistry()
	if err = registry.Register("repair-row", h); err != nil {
		t.Fatal(err)
	}
	r, err := client.ProposeRepair(ctx, rhinoq.RepairProposal{ID: "repair-pg-1", Finding: key, Handler: "repair-row", Parameters: json.RawMessage(`{}`), Actor: "alice"})
	if err != nil {
		t.Fatal(err)
	}
	r, err = client.PreviewRepair(ctx, r.ID, registry)
	if err != nil {
		t.Fatal(err)
	}
	r, err = client.ApproveRepair(ctx, r.ID, "bob", "reviewed diff")
	if err != nil {
		t.Fatal(err)
	}
	r, err = client.ExecuteRepair(ctx, r.ID, registry)
	if err != nil {
		t.Fatal(err)
	}
	if r.State != "succeeded" || h.applied != 1 {
		t.Fatalf("repair=%+v applied=%d", r, h.applied)
	}
	findings, err := client.ListFindings(ctx, rhinoq.FindingQuery{RuleID: key.RuleID, IncludeSuppressed: true, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 1 || findings[0].Status != rhinoq.FindingResolved {
		t.Fatalf("finding not resolved: %+v", findings)
	}
}
