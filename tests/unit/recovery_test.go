package unit

import (
	"errors"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/effect"
	"github.com/madebyduy/RhinoQ/internal/domain/job"
	"github.com/madebyduy/RhinoQ/internal/domain/recovery"
)

func TestReplayValidationFailsClosedForEffects(t *testing.T) {
	now := time.Date(2026, 7, 27, 13, 0, 0, 0, time.UTC)
	record := job.Record{ID: "job_1", State: job.Dead}
	request := recovery.ReplayRequest{JobID: record.ID, Actor: "operator@example.com", Reason: "provider recovered", RequestedAt: now}

	cases := []struct {
		name  string
		state effect.State
		want  error
	}{
		{name: "confirmed", state: effect.Confirmed, want: recovery.ErrConfirmedEffect},
		{name: "uncertain", state: effect.Uncertain, want: recovery.ErrUncertainEffect},
		{name: "pending", state: effect.Pending, want: recovery.ErrUnresolvedEffect},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			err := recovery.ValidateReplay(record, []effect.Record{{State: test.state}}, request)
			if !errors.Is(err, test.want) {
				t.Fatalf("expected %v, got %v", test.want, err)
			}
		})
	}
	if err := recovery.ValidateReplay(record, []effect.Record{{State: effect.NotHappened}}, request); err != nil {
		t.Fatalf("not-happened effect should allow replay: %v", err)
	}
}

func TestAuditHashDetectsChangedEvidence(t *testing.T) {
	record := recovery.AuditRecord{
		ID: "audit_1", JobID: "job_1", Action: "job_replayed",
		Actor: "operator@example.com", Reason: "dependency recovered",
		OccurredAt: time.Date(2026, 7, 27, 13, 0, 0, 0, time.UTC),
	}
	original := recovery.HashAudit("", record)
	record.Reason = "changed after the fact"
	if changed := recovery.HashAudit("", record); original == changed {
		t.Fatal("changed audit evidence must produce a different hash")
	}
}

func TestAttentionQueryHasABoundedPaginationWindow(t *testing.T) {
	valid := recovery.AttentionQuery{Offset: 9_000, Limit: 1_000}
	if err := recovery.ValidateAttentionQuery(valid); err != nil {
		t.Fatalf("last bounded page should be valid: %v", err)
	}
	tooDeep := recovery.AttentionQuery{Offset: 9_001, Limit: 1_000}
	if err := recovery.ValidateAttentionQuery(tooDeep); !errors.Is(
		err, recovery.ErrInvalidAttentionQuery,
	) {
		t.Fatalf("deep offset must be rejected instead of truncated: %v", err)
	}
}
