package integration

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/rhinoq/rhinoq/internal/adapters/memory"
	"github.com/rhinoq/rhinoq/internal/domain/effect"
	"github.com/rhinoq/rhinoq/internal/domain/job"
	"github.com/rhinoq/rhinoq/internal/domain/outcome"
	"github.com/rhinoq/rhinoq/internal/domain/recovery"
	"github.com/rhinoq/rhinoq/internal/ports"
)

func TestGuardedReplayIsAuditedAndPreservesAttempts(t *testing.T) {
	now := time.Date(2026, 7, 27, 14, 0, 0, 0, time.UTC)
	jobs := memory.NewJobStoreWithClock(func() time.Time { return now })
	effects := memory.NewEffectStore()
	outcomes := memory.NewOutcomeStore()
	store, err := memory.NewRecoveryStore(jobs, effects, outcomes)
	if err != nil {
		t.Fatal(err)
	}
	id := deadJobFixture(t, jobs, now, "reports")

	replayed, audit, err := store.Replay(context.Background(), recovery.ReplayRequest{
		JobID: id, Actor: "ops@example.com", Reason: "dependency recovered", RequestedAt: now.Add(time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	if replayed.State != job.Pending || replayed.Attempts != 1 {
		t.Fatalf("replay must preserve attempt evidence and return to pending: %+v", replayed)
	}
	if audit.RowHash == "" || audit.PrevHash != "" {
		t.Fatalf("first audit row must start a hash chain: %+v", audit)
	}
	history, err := store.ListAudit(context.Background(), id, 0, 10)
	if err != nil || len(history) != 1 || history[0].RowHash != audit.RowHash {
		t.Fatalf("unexpected audit history: %+v err=%v", history, err)
	}

	secondClaim, err := jobs.Claim(context.Background(), ports.ClaimInput{
		Now: now.Add(time.Minute), Limit: 1, LeaseDuration: time.Minute,
	})
	if err != nil || len(secondClaim) != 1 {
		t.Fatalf("claim replayed job: len=%d err=%v", len(secondClaim), err)
	}
	secondLease := ports.Lease{JobID: id, LeaseID: secondClaim[0].LeaseID}
	if err := jobs.Fail(context.Background(), secondLease, now.Add(time.Minute), ports.FailureTransition{
		State: job.Dead, NotBefore: now.Add(time.Minute),
	}); err != nil {
		t.Fatal(err)
	}
	_, secondAudit, err := store.Replay(context.Background(), recovery.ReplayRequest{
		JobID: id, Actor: "ops@example.com", Reason: "approved second replay", RequestedAt: now.Add(2 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	if secondAudit.PrevHash != audit.RowHash {
		t.Fatalf("second audit row must chain to first: %+v", secondAudit)
	}
	history, err = store.ListAudit(context.Background(), id, 0, 10)
	if err != nil || len(history) != 2 || history[0].RowHash != secondAudit.RowHash {
		t.Fatalf("audit history must be newest first: %+v err=%v", history, err)
	}
}

func TestNeedsAttentionCombinesExecutionEffectAndOutcomeFindings(t *testing.T) {
	now := time.Date(2026, 7, 27, 15, 0, 0, 0, time.UTC)
	jobs := memory.NewJobStoreWithClock(func() time.Time { return now })
	effects := memory.NewEffectStore()
	outcomes := memory.NewOutcomeStore()
	store, err := memory.NewRecoveryStore(jobs, effects, outcomes)
	if err != nil {
		t.Fatal(err)
	}
	id := deadJobFixture(t, jobs, now, "media")

	effectRecord, err := effect.NewRecord("effect_1", id.String(), "upload", "upload:1", false, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := effects.BeginEffect(context.Background(), effectRecord); err != nil {
		t.Fatal(err)
	}
	effectRecord, err = effectRecord.MarkUncertain()
	if err != nil {
		t.Fatal(err)
	}
	if err := effects.SaveEffect(context.Background(), effectRecord); err != nil {
		t.Fatal(err)
	}

	outcomeRecord, err := outcome.NewRecord("outcome_1", id.String(), outcome.Contract{Version: 1}, now)
	if err != nil {
		t.Fatal(err)
	}
	outcomeRecord, err = outcomeRecord.Apply(outcome.Observation{State: outcome.Mismatch, Reason: "two media files are incomplete"}, now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if err := outcomes.SaveOutcome(context.Background(), outcomeRecord); err != nil {
		t.Fatal(err)
	}

	items, err := store.ListAttention(context.Background(), recovery.AttentionQuery{Queue: "media", Limit: 10})
	if err != nil || len(items) != 3 {
		t.Fatalf("expected dead, uncertain effect and mismatch findings: len=%d err=%v items=%+v", len(items), err, items)
	}
	_, _, err = store.Replay(context.Background(), recovery.ReplayRequest{
		JobID: id, Actor: "ops@example.com", Reason: "try again", RequestedAt: now.Add(3 * time.Second),
	})
	if !errors.Is(err, recovery.ErrUncertainEffect) {
		t.Fatalf("uncertain effect must block replay, got %v", err)
	}
}

func deadJobFixture(t *testing.T, jobs *memory.JobStore, now time.Time, name string) job.ID {
	t.Helper()
	id, err := jobs.Enqueue(context.Background(), ports.EnqueueInput{Name: name, Payload: []byte("{}")})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := jobs.Claim(context.Background(), ports.ClaimInput{Now: now, Limit: 1, LeaseDuration: time.Minute})
	if err != nil || len(claimed) != 1 {
		t.Fatalf("claim fixture: len=%d err=%v", len(claimed), err)
	}
	lease := ports.Lease{JobID: id, LeaseID: claimed[0].LeaseID}
	if err := jobs.Fail(context.Background(), lease, now, ports.FailureTransition{State: job.Dead, NotBefore: now}); err != nil {
		t.Fatal(err)
	}
	return id
}
