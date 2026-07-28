package integration

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

// The provider must be called once no matter how many attempts the job takes.
func TestEffectRunIsSkippedOnceConfirmed(t *testing.T) {
	client := rhinoq.NewInMemory()
	calls := 0
	var result rhinoq.EffectResult
	if err := client.Handle("charge", func(ctx context.Context, job rhinoq.Job) error {
		effect, err := job.Effect(ctx, rhinoq.EffectRequest{
			Name: "charge-card", Key: job.ID, Irreversible: true, Confirm: rhinoq.ConfirmOnReturn,
		}, func(context.Context) (string, error) {
			calls++
			return "provider-ref-1", nil
		})
		result = effect
		return err
	}); err != nil {
		t.Fatal(err)
	}
	runOneJob(t, client, "charge")

	if calls != 1 || result.State != rhinoq.EffectConfirmed || result.ExternalRef != "provider-ref-1" {
		t.Fatalf("expected one confirmed provider call: calls=%d result=%+v", calls, result)
	}
}

// An unknown provider result is not a failure to retry: it becomes uncertain,
// and the next attempt refuses to run the call again.
func TestEffectRunTurnsUnknownResultsIntoUncertain(t *testing.T) {
	client := rhinoq.NewInMemory()
	calls := 0
	failures := make(chan error, 4)
	if err := client.Handle("charge", func(ctx context.Context, job rhinoq.Job) error {
		_, err := job.Effect(ctx, rhinoq.EffectRequest{
			Name: "charge-card", Key: job.ID, Irreversible: true,
		}, func(context.Context) (string, error) {
			calls++
			return "", errors.New("timeout waiting for provider")
		})
		failures <- err
		return err
	}); err != nil {
		t.Fatal(err)
	}
	runOneJob(t, client, "charge")

	select {
	case err := <-failures:
		if err == nil {
			t.Fatal("the handler should have seen the provider error")
		}
	case <-time.After(time.Second):
		t.Fatal("handler did not run")
	}
	// The retry runs the handler again, and the ledger stops the second charge.
	select {
	case err := <-failures:
		if !errors.Is(err, rhinoq.ErrEffectUncertain) {
			t.Fatalf("a retry must refuse an uncertain effect, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the job was not retried")
	}
	if calls != 1 {
		t.Fatalf("the provider must be called once, got %d", calls)
	}
}

// A call that provably never reached the provider stays retryable.
func TestEffectRunKeepsNotHappenedWorkRetryable(t *testing.T) {
	client := rhinoq.NewInMemory()
	states := make(chan string, 4)
	if err := client.Handle("charge", func(ctx context.Context, job rhinoq.Job) error {
		effect, err := job.Effect(ctx, rhinoq.EffectRequest{
			Name: "charge-card", Key: job.ID, Irreversible: true,
		}, func(context.Context) (string, error) {
			return "", rhinoq.NotHappened(errors.New("connection refused"))
		})
		states <- effect.State
		return err
	}); err != nil {
		t.Fatal(err)
	}
	runOneJob(t, client, "charge")

	select {
	case state := <-states:
		if state != rhinoq.EffectNotHappened {
			t.Fatalf("a call that never reached the provider must be recorded as such, got %q", state)
		}
	case <-time.After(time.Second):
		t.Fatal("handler did not run")
	}
}

func TestEffectRunHonoursStatusPredicate(t *testing.T) {
	client := rhinoq.NewInMemory()
	results := make(chan rhinoq.EffectResult, 2)
	if err := client.Handle("transfer", func(ctx context.Context, job rhinoq.Job) error {
		effect, err := job.Effect(ctx, rhinoq.EffectRequest{
			Name: "transfer", Key: job.ID, Irreversible: true,
			Confirm: rhinoq.ConfirmWhenStatus, CompletedStatus: "settled",
		}, func(context.Context) (string, error) {
			return "accepted", nil
		})
		results <- effect
		return err
	}); err != nil {
		t.Fatal(err)
	}
	runOneJob(t, client, "transfer")

	select {
	case effect := <-results:
		// The provider accepted the request but has not settled it, so the
		// effect must not be treated as done.
		if effect.State != rhinoq.EffectPending {
			t.Fatalf("an accepted-but-not-settled effect must stay pending, got %+v", effect)
		}
	case <-time.After(time.Second):
		t.Fatal("handler did not run")
	}
}

func runOneJob(t *testing.T, client *rhinoq.Client, queue string) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	if _, err := client.Enqueue(ctx, rhinoq.JobRequest{Name: queue, Payload: []byte("{}")}); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		done <- client.RunWorker(ctx, rhinoq.WorkerConfig{
			Name: "worker-1", Concurrency: 1, PollInterval: time.Millisecond,
			Lease: time.Minute, Heartbeat: 10 * time.Second, MaxAttempts: 2,
			RetryBaseDelay: time.Millisecond, RetryMaxDelay: time.Millisecond,
		})
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Error("worker did not stop")
		}
	})
	waitForTerminalState(t, client, queue)
}

func waitForTerminalState(t *testing.T, client *rhinoq.Client, queue string) {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		counts, err := client.JobCounts(context.Background(), queue)
		if err != nil {
			t.Fatal(err)
		}
		if counts["succeeded"]+counts["dead"]+counts["blocked"] > 0 {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("job did not reach a terminal state: %+v", counts)
		case <-time.After(2 * time.Millisecond):
		}
	}
}
