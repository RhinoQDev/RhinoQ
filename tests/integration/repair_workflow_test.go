package integration_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

type demoRepair struct {
	precondition string
	applied      int
}

func (h *demoRepair) Preview(context.Context, rhinoq.FindingKey, json.RawMessage) (rhinoq.RepairPreview, error) {
	return rhinoq.RepairPreview{Summary: "set invoice paid", Precondition: h.precondition}, nil
}
func (h *demoRepair) Apply(_ context.Context, _ rhinoq.FindingKey, _ json.RawMessage, token string) (rhinoq.RepairApplyResult, error) {
	h.applied++
	return rhinoq.RepairApplyResult{Outcome: "updated with " + token}, nil
}
func (h *demoRepair) Verify(context.Context, rhinoq.FindingKey, json.RawMessage) (rhinoq.RepairVerification, error) {
	return rhinoq.RepairVerification{Passed: true, Evidence: "invoice is paid"}, nil
}

func TestRepairRequiresPreviewFourEyesAndFreshPrecondition(t *testing.T) {
	client := rhinoq.NewInMemory()
	ctx := context.Background()
	key := rhinoq.FindingKey{RuleID: "invoice-paid", SubjectType: "invoice", SubjectID: "inv-7", InvariantVersion: 1}
	_, err := client.ObserveFinding(ctx, rhinoq.FindingObservation{FindingKey: key, Evidence: "paid_at is null", ObservedAt: time.Now().UTC()})
	if err != nil {
		t.Fatal(err)
	}
	h := &demoRepair{precondition: "row-version-1"}
	registry := rhinoq.NewRepairRegistry()
	if err = registry.Register("mark-paid", h); err != nil {
		t.Fatal(err)
	}
	proposed, err := client.ProposeRepair(ctx, rhinoq.RepairProposal{ID: "repair-inv-7", Finding: key, Handler: "mark-paid", Parameters: json.RawMessage(`{"paid":true}`), Actor: "alice"})
	if err != nil {
		t.Fatal(err)
	}
	previewed, err := client.PreviewRepair(ctx, proposed.ID, registry)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = client.ApproveRepair(ctx, previewed.ID, "alice", "self approve"); err == nil {
		t.Fatal("self approval accepted")
	}
	approved, err := client.ApproveRepair(ctx, previewed.ID, "bob", "checked customer receipt")
	if err != nil {
		t.Fatal(err)
	}
	h.precondition = "row-version-2"
	stale, err := client.ExecuteRepair(ctx, approved.ID, registry)
	if err != nil {
		t.Fatal(err)
	}
	if stale.State != "stale" || h.applied != 0 {
		t.Fatalf("stale plan mutated data: %+v applied=%d", stale, h.applied)
	}
}
