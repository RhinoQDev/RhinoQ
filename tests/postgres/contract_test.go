package postgres_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/rhinoq/rhinoq/internal/domain/job"
	"github.com/rhinoq/rhinoq/internal/ports"
	"github.com/rhinoq/rhinoq/internal/runtime/lease"
	"github.com/rhinoq/rhinoq/pkg/rhinoq"
)

func TestEnqueueIsIdempotentPerQueue(t *testing.T) {
	client := newClient(t)
	first := enqueue(t, client, rhinoq.JobRequest{
		Name: "send-email", Payload: []byte(`{"to":"a@example.com"}`), IdempotencyKey: "user:1",
	})
	second := enqueue(t, client, rhinoq.JobRequest{
		Name: "send-email", Payload: []byte(`{"to":"a@example.com"}`), IdempotencyKey: "user:1",
	})
	if first != second {
		t.Fatalf("a repeated idempotency key must return the first job: %s vs %s", first, second)
	}
	// The same key in another queue is a different job.
	other := enqueue(t, client, rhinoq.JobRequest{
		Name: "send-sms", Payload: []byte("{}"), IdempotencyKey: "user:1",
	})
	if other == first {
		t.Fatal("idempotency is scoped to the queue name")
	}
	counts, err := client.JobCounts(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if counts["pending"] != 2 {
		t.Fatalf("expected two pending jobs, got %+v", counts)
	}
}

// The claim SQL must produce the same order as the Go implementation: priority
// first, FIFO inside a priority.
func TestClaimOrdersByPriorityThenFirstIn(t *testing.T) {
	client := newClient(t)
	firstNormal := enqueue(t, client, rhinoq.JobRequest{Name: "mixed", Payload: []byte("{}")})
	time.Sleep(5 * time.Millisecond)
	secondNormal := enqueue(t, client, rhinoq.JobRequest{Name: "mixed", Payload: []byte("{}")})
	time.Sleep(5 * time.Millisecond)
	urgent := enqueue(t, client, rhinoq.JobRequest{Name: "mixed", Payload: []byte("{}"), Priority: 10})

	claimed := claim(t, client, "worker-1", 3, time.Minute)
	if len(claimed) != 3 {
		t.Fatalf("expected three claimed jobs, got %d", len(claimed))
	}
	want := []string{urgent, firstNormal, secondNormal}
	for index, expected := range want {
		if claimed[index].Job.ID != expected {
			t.Fatalf("claim order %d: expected %s, got %s", index, expected, claimed[index].Job.ID)
		}
	}
	if claimed[0].Lease.Epoch != 1 || claimed[0].Lease.Owner != "worker-1" {
		t.Fatalf("claim must return a fencing token: %+v", claimed[0].Lease)
	}
	if !claimed[0].ExpiresAt.After(time.Now().Add(30 * time.Second)) {
		t.Fatalf("the lease deadline must come from the database: %s", claimed[0].ExpiresAt)
	}
}

func TestClaimFiltersQueuesBeforeTakingLocks(t *testing.T) {
	client := newClient(t)
	emailID := enqueue(t, client, rhinoq.JobRequest{
		Name: "send-email", Payload: []byte("{}"),
	})
	enqueue(t, client, rhinoq.JobRequest{
		Name: "resize-image", Payload: []byte("{}"), Priority: 100,
	})

	claimed, err := client.ClaimJobs(context.Background(), rhinoq.ClaimRequest{
		Worker: "email-worker", Queues: []string{"send-email"},
		Limit: 5, LeaseFor: time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(claimed) != 1 || claimed[0].Job.ID != emailID {
		t.Fatalf("worker must only lock its registered queues: %+v", claimed)
	}
	counts, err := client.JobCounts(context.Background(), "resize-image")
	if err != nil {
		t.Fatal(err)
	}
	if counts["pending"] != 1 {
		t.Fatalf("unhandled high-priority work must stay pending: %+v", counts)
	}
}

func TestDelayedJobWaitsForItsTime(t *testing.T) {
	client := newClient(t)
	enqueue(t, client, rhinoq.JobRequest{Name: "later", Payload: []byte("{}"), RunAfter: time.Hour})
	if jobs := claim(t, client, "worker-1", 5, time.Minute); len(jobs) != 0 {
		t.Fatalf("a delayed job must not be claimable yet: %d", len(jobs))
	}
}

// Every write after a claim has to present the current owner and epoch. This is
// the test that proves the SQL, not just the Go, refuses a stale execution.
func TestStaleEpochIsRefusedByEveryWrite(t *testing.T) {
	client := newClient(t)
	id := enqueue(t, client, rhinoq.JobRequest{Name: "charge", Payload: []byte("{}")})
	first := claimOne(t, client, "worker-1")
	stale := first.Lease

	expireLeases(t)
	reaper, err := lease.NewReaper(lease.Config{
		Store: mustStore(t), Interval: time.Hour, Now: func() time.Time { return time.Now().UTC() },
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := reaper.Sweep(context.Background())
	if err != nil || result.Requeued != 1 {
		t.Fatalf("the sweep should requeue the abandoned job: %+v err=%v", result, err)
	}

	second := claimOne(t, client, "worker-2")
	if second.Lease.Epoch != stale.Epoch+1 {
		t.Fatalf("a claim must advance the epoch: %d -> %d", stale.Epoch, second.Lease.Epoch)
	}

	ctx := context.Background()
	writes := map[string]func() error{
		"complete": func() error { return client.CompleteJob(ctx, stale) },
		"release":  func() error { return client.ReleaseJob(ctx, stale) },
		"heartbeat": func() error {
			_, err := client.Heartbeat(ctx, stale, time.Minute)
			return err
		},
		"fail": func() error {
			_, err := client.FailJob(ctx, stale, rhinoq.FailureReport{RetryClass: rhinoq.RetryPermanent})
			return err
		},
		"begin effect": func() error {
			_, err := client.BeginEffect(ctx, stale, rhinoq.EffectRequest{
				Name: "charge", Key: "charge:1", Irreversible: true,
			})
			return err
		},
	}
	for name, write := range writes {
		if err := write(); !errors.Is(err, rhinoq.ErrLeaseLost) {
			t.Fatalf("%s from a stale epoch must be fenced, got %v", name, err)
		}
	}

	if state := jobState(t, client, "charge", id); state.State != "leased" {
		t.Fatalf("the live execution must keep the job, got %s", state.State)
	}
	// The live execution still works.
	if err := client.CompleteJob(ctx, second.Lease); err != nil {
		t.Fatalf("the current execution must be able to complete: %v", err)
	}
}

func TestHeartbeatReportsCancellationInOneCall(t *testing.T) {
	client := newClient(t)
	id := enqueue(t, client, rhinoq.JobRequest{Name: "long", Payload: []byte("{}")})
	leased := claimOne(t, client, "worker-1")

	state, err := client.Heartbeat(context.Background(), leased.Lease, time.Minute)
	if err != nil || state.CancelRequested {
		t.Fatalf("a job nobody cancelled must not report a cancellation: %+v err=%v", state, err)
	}
	if err := client.Cancel(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	state, err = client.Heartbeat(context.Background(), leased.Lease, time.Minute)
	if err != nil || !state.CancelRequested {
		t.Fatalf("the heartbeat must surface the cancellation: %+v err=%v", state, err)
	}
}

func TestReleasedJobGivesBackItsAttempt(t *testing.T) {
	client := newClient(t)
	id := enqueue(t, client, rhinoq.JobRequest{Name: "prefetched", Payload: []byte("{}")})
	leased := claimOne(t, client, "worker-1")
	if leased.Job.Attempts != 1 {
		t.Fatalf("a claim consumes an attempt: %+v", leased.Job)
	}
	if err := client.ReleaseJob(context.Background(), leased.Lease); err != nil {
		t.Fatal(err)
	}
	state := jobState(t, client, "prefetched", id)
	if state.State != "retry_wait" || state.Attempts != 0 {
		t.Fatalf("work that never ran must keep its full attempt budget: %+v", state)
	}
}

func TestFailureClassDecidesTheOutcome(t *testing.T) {
	client := newClient(t)
	if err := client.SetRetryPolicy(3, 50*time.Millisecond, time.Second); err != nil {
		t.Fatal(err)
	}

	permanentID := enqueue(t, client, rhinoq.JobRequest{Name: "classified", Payload: []byte("{}")})
	permanent := claimOne(t, client, "worker-1")
	summary, err := client.FailJob(context.Background(), permanent.Lease, rhinoq.FailureReport{
		Type: "UnsupportedUrlError", RetryClass: rhinoq.RetryPermanent, Message: "unsupported url",
	})
	if err != nil || summary.State != "dead" {
		t.Fatalf("a permanent error must not be retried: %+v err=%v", summary, err)
	}
	if state := jobState(t, client, "classified", permanentID); state.State != "dead" {
		t.Fatalf("expected dead, got %s", state.State)
	}

	transientID := enqueue(t, client, rhinoq.JobRequest{Name: "classified", Payload: []byte("{}")})
	transient := claimOne(t, client, "worker-1")
	summary, err = client.FailJob(context.Background(), transient.Lease, rhinoq.FailureReport{
		RetryClass: rhinoq.RetryTransient, Message: "connection reset",
	})
	if err != nil || summary.State != "retry_wait" {
		t.Fatalf("a transient error must be retried: %+v err=%v", summary, err)
	}
	// The retry delay is computed by the database, so it must be in the future.
	state := jobState(t, client, "classified", transientID)
	if !state.NotBefore.After(time.Now()) {
		t.Fatalf("a retry must be scheduled forward in time: %s", state.NotBefore)
	}
}

func TestRateLimitIsSharedAcrossWorkers(t *testing.T) {
	client := newClient(t)
	if err := client.SetRateLimit(context.Background(), "throttled", 2, time.Hour); err != nil {
		t.Fatal(err)
	}
	for count := 0; count < 4; count++ {
		enqueue(t, client, rhinoq.JobRequest{Name: "throttled", Payload: []byte("{}")})
	}

	first := claim(t, client, "worker-1", 10, time.Minute)
	if len(first) != 2 {
		t.Fatalf("the window allows two jobs, got %d", len(first))
	}
	second := claim(t, client, "worker-2", 10, time.Minute)
	if len(second) != 0 {
		t.Fatalf("a second worker must not get more of the same window: %d", len(second))
	}
	ttl, err := client.RateLimitTTL(context.Background(), "throttled")
	if err != nil || ttl <= 0 {
		t.Fatalf("a saturated queue must report when it reopens: %s err=%v", ttl, err)
	}
}

func TestPauseStopsClaimingWithoutTouchingRunningWork(t *testing.T) {
	client := newClient(t)
	enqueue(t, client, rhinoq.JobRequest{Name: "paused-queue", Payload: []byte("{}")})
	if err := client.Pause(context.Background(), "paused-queue"); err != nil {
		t.Fatal(err)
	}
	if jobs := claim(t, client, "worker-1", 5, time.Minute); len(jobs) != 0 {
		t.Fatalf("a paused queue must not be claimed: %d", len(jobs))
	}
	if err := client.Resume(context.Background(), "paused-queue"); err != nil {
		t.Fatal(err)
	}
	if jobs := claim(t, client, "worker-1", 5, time.Minute); len(jobs) != 1 {
		t.Fatalf("resuming must release the work: %d", len(jobs))
	}
}

func TestAdmissionRejectsOverflowAndReservesCriticalRoom(t *testing.T) {
	client := newClient(t)
	ctx := context.Background()
	if err := client.SetAdmission(ctx, "reports", rhinoq.AdmissionPolicy{
		MaxPending: 3, ReservedCritical: 1, OnOverflow: rhinoq.OverflowReject,
		RetryAfter: 30 * time.Second,
	}); err != nil {
		t.Fatal(err)
	}
	for count := 0; count < 2; count++ {
		enqueue(t, client, rhinoq.JobRequest{Name: "reports", Payload: []byte("{}")})
	}
	_, err := client.Enqueue(ctx, rhinoq.JobRequest{Name: "reports", Payload: []byte("{}")})
	if !errors.Is(err, rhinoq.ErrQueueOverCapacity) {
		t.Fatalf("standard work must stop at the reserved line, got %v", err)
	}
	if _, err := client.Enqueue(ctx, rhinoq.JobRequest{
		Name: "reports", Payload: []byte("{}"), Class: rhinoq.ClassCritical,
	}); err != nil {
		t.Fatalf("critical work must still be admitted: %v", err)
	}
}

func TestAdmissionDelayModeDefersInsteadOfRejecting(t *testing.T) {
	client := newClient(t)
	ctx := context.Background()
	if err := client.SetAdmission(ctx, "telemetry", rhinoq.AdmissionPolicy{
		MaxPending: 1, OnOverflow: rhinoq.OverflowDelay, DelayBy: time.Hour,
	}); err != nil {
		t.Fatal(err)
	}
	enqueue(t, client, rhinoq.JobRequest{Name: "telemetry", Payload: []byte("{}")})
	deferred := enqueue(t, client, rhinoq.JobRequest{Name: "telemetry", Payload: []byte("{}")})

	state := jobState(t, client, "telemetry", deferred)
	if !state.NotBefore.After(time.Now().Add(30 * time.Minute)) {
		t.Fatalf("overflow should push the run time out: %s", state.NotBefore)
	}
	if jobs := claim(t, client, "worker-1", 10, time.Minute); len(jobs) != 1 {
		t.Fatalf("only the admitted job is claimable now: %d", len(jobs))
	}
}

// A payload that keeps killing workers never records a failed attempt, so only
// the crash budget can stop it.
func TestPoisonJobIsParkedAfterRepeatedCrashes(t *testing.T) {
	client := newClient(t)
	id := enqueue(t, client, rhinoq.JobRequest{Name: "poison", Payload: []byte("{}")})
	reaper, err := lease.NewReaper(lease.Config{
		Store: mustStore(t), Interval: time.Hour,
		Protection: job.Protection{MaxWorkerCrashesPerJob: 2},
		Now:        func() time.Time { return time.Now().UTC() },
	})
	if err != nil {
		t.Fatal(err)
	}

	for crash := 1; crash <= 2; crash++ {
		claimOne(t, client, "worker-1")
		expireLeases(t)
		result, err := reaper.Sweep(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if crash == 1 && result.Requeued != 1 {
			t.Fatalf("the first crash should requeue: %+v", result)
		}
		if crash == 2 && result.Blocked != 1 {
			t.Fatalf("the second crash should park the job: %+v", result)
		}
	}

	state := jobState(t, client, "poison", id)
	if state.State != "blocked" || state.BlockedReason != string(job.BlockedPoisonJob) {
		t.Fatalf("expected a parked poison job: %+v", state)
	}
	if jobs := claim(t, client, "worker-2", 5, time.Minute); len(jobs) != 0 {
		t.Fatalf("a parked job must not reach another worker: %d", len(jobs))
	}
}

func mustStore(t *testing.T) ports.JobStore {
	t.Helper()
	store, err := newJobStore()
	if err != nil {
		t.Fatalf("build job store: %v", err)
	}
	return store
}
