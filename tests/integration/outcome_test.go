package integration

import (
	"context"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/adapters/memory"
	"github.com/madebyduy/RhinoQ/internal/application/verification"
	"github.com/madebyduy/RhinoQ/internal/domain/outcome"
)

type fixedVerifier struct {
	observation outcome.Observation
}

func (v fixedVerifier) Verify(context.Context, string, outcome.Contract) (outcome.Observation, error) {
	return v.observation, nil
}

func TestVerifyOutcomePersistsObservation(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	store := memory.NewOutcomeStore()
	record, err := outcome.NewRecord("outcome_1", "job_1", outcome.Contract{Version: 1}, now)
	if err != nil {
		t.Fatal(err)
	}

	service := verification.NewVerifyOutcome(store, fixedVerifier{observation: outcome.Observation{
		State:  outcome.Achieved,
		Reason: "report is ready",
	}}, func() time.Time { return now })
	updated, err := service.Execute(context.Background(), record, outcome.Contract{Version: 1})
	if err != nil {
		t.Fatal(err)
	}
	if updated.State != outcome.Achieved {
		t.Fatalf("expected achieved outcome, got %s", updated.State)
	}
	persisted, ok, err := store.GetOutcome(context.Background(), record.ID)
	if err != nil || !ok || persisted.State != outcome.Achieved {
		t.Fatalf("expected persisted achieved outcome, ok=%v err=%v record=%+v", ok, err, persisted)
	}
}
