package unit

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/adapters/memory"
	"github.com/madebyduy/RhinoQ/internal/domain/job"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

func TestIdentityRequiresBothLaneAndContract(t *testing.T) {
	if _, err := (job.Identity{JobName: "send-email"}).Normalize(); !errors.Is(err, job.ErrEmptyQueueName) {
		t.Fatalf("a contract without a lane cannot be claimed for, want ErrEmptyQueueName, got %v", err)
	}
	if _, err := (job.Identity{QueueName: "notifications"}).Normalize(); !errors.Is(err, job.ErrEmptyJobName) {
		t.Fatalf("a lane without a contract cannot be dispatched, want ErrEmptyJobName, got %v", err)
	}
	// Whitespace must not smuggle an empty name past the check.
	if _, err := (job.Identity{QueueName: "  ", JobName: "send-email"}).Normalize(); !errors.Is(err, job.ErrEmptyQueueName) {
		t.Fatalf("a blank lane must be rejected, got %v", err)
	}
}

func TestIdentityBoundsEveryPart(t *testing.T) {
	long := strings.Repeat("q", job.MaxIdentityPartBytes+1)
	for _, identity := range []job.Identity{
		{QueueName: long, JobName: "j"},
		{QueueName: "q", JobName: long},
		{QueueName: "q", JobName: "j", GroupKey: long},
	} {
		if _, err := identity.Normalize(); !errors.Is(err, job.ErrIdentityTooLong) {
			t.Fatalf("identity %+v must be bounded, got %v", identity, err)
		}
	}
}

func TestIdentityDefaultsResourceClassToStandard(t *testing.T) {
	identity, err := (job.Identity{QueueName: "reports", JobName: "generate"}).Normalize()
	if err != nil {
		t.Fatal(err)
	}
	if identity.ResourceClass != job.Standard {
		t.Fatalf("an unset resource class must resolve to standard, got %q", identity.ResourceClass)
	}
}

// The whole point of the split: two unrelated contracts in one lane share a
// worker pool, and a worker subscribed to that lane receives both.
func TestOneLaneCarriesUnrelatedContracts(t *testing.T) {
	ctx := context.Background()
	store := memory.NewJobStore()

	for _, jobName := range []string{"send-email", "generate-report"} {
		if _, err := store.Enqueue(ctx, ports.EnqueueInput{
			Identity: job.Identity{QueueName: "shared", JobName: jobName},
			Payload:  []byte("{}"),
		}); err != nil {
			t.Fatalf("enqueue %s: %v", jobName, err)
		}
	}

	claimed, err := store.Claim(ctx, ports.ClaimInput{
		Owner: "worker-1", Now: time.Now().UTC(), Limit: 10,
		LeaseDuration: time.Minute, QueueNames: []string{"shared"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(claimed) != 2 {
		t.Fatalf("subscribing to a lane must yield every contract in it, got %d", len(claimed))
	}
	seen := map[string]bool{}
	for _, record := range claimed {
		if record.QueueName != "shared" {
			t.Fatalf("claim must not cross lanes, got %q", record.QueueName)
		}
		seen[record.JobName] = true
	}
	if !seen["send-email"] || !seen["generate-report"] {
		t.Fatalf("both contracts must arrive, got %v", seen)
	}
}

// Idempotency is scoped to the lane, not the contract: the same key in two
// lanes is two different jobs.
func TestIdempotencyIsScopedToTheLane(t *testing.T) {
	ctx := context.Background()
	store := memory.NewJobStore()

	first, err := store.Enqueue(ctx, ports.EnqueueInput{
		Identity:       job.Identity{QueueName: "lane-a", JobName: "send"},
		Payload:        []byte("{}"),
		IdempotencyKey: "user:1",
	})
	if err != nil {
		t.Fatal(err)
	}
	repeat, err := store.Enqueue(ctx, ports.EnqueueInput{
		Identity:       job.Identity{QueueName: "lane-a", JobName: "send"},
		Payload:        []byte("{}"),
		IdempotencyKey: "user:1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if repeat != first {
		t.Fatalf("the same key in one lane must fold into the first job: %s vs %s", repeat, first)
	}

	other, err := store.Enqueue(ctx, ports.EnqueueInput{
		Identity:       job.Identity{QueueName: "lane-b", JobName: "send"},
		Payload:        []byte("{}"),
		IdempotencyKey: "user:1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if other == first {
		t.Fatal("the same key in a different lane must be a different job")
	}
}
