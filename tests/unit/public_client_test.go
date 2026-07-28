package unit

import (
	"context"
	"testing"
	"time"

	"github.com/rhinoq/rhinoq/pkg/rhinoq"
)

func TestPublicClientUsesStoreBoundary(t *testing.T) {
	client := rhinoq.NewInMemory()
	if err := client.Handle("demo", func(context.Context, rhinoq.Job) error { return nil }); err != nil {
		t.Fatal(err)
	}
	id, err := client.Enqueue(context.Background(), rhinoq.JobRequest{
		Name: "demo", Payload: []byte("{}"), IdempotencyKey: "demo:1",
	})
	if err != nil || id == "" {
		t.Fatalf("expected public enqueue, id=%q err=%v", id, err)
	}
	if err := client.SetRateLimit(context.Background(), "demo", 10, time.Second); err != nil {
		t.Fatalf("expected public rate-limit configuration: %v", err)
	}
	counts, err := client.JobCounts(context.Background(), "demo")
	if err != nil || counts["pending"] != 1 {
		t.Fatalf("expected public job counts, counts=%+v err=%v", counts, err)
	}
	jobs, err := client.ListJobs(context.Background(), rhinoq.JobQuery{
		Queue: "demo", States: []string{"pending"}, Limit: 10,
	})
	if err != nil || len(jobs) != 1 || jobs[0].ID != id {
		t.Fatalf("expected public job listing, jobs=%+v err=%v", jobs, err)
	}
}

func TestPublicClientRejectsNegativeRunAfter(t *testing.T) {
	client := rhinoq.NewInMemory()
	if _, err := client.Enqueue(context.Background(), rhinoq.JobRequest{
		Name: "demo", Payload: []byte("{}"), RunAfter: -time.Second,
	}); err == nil {
		t.Fatal("negative run-after must be rejected instead of using ambiguous wall-clock behavior")
	}
}
