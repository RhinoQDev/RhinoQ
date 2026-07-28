package unit

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

func TestPublicClientUsesStoreBoundary(t *testing.T) {
	client := rhinoq.NewInMemory()
	if err := client.Handle("demo", "demo", func(context.Context, rhinoq.Job) error { return nil }); err != nil {
		t.Fatal(err)
	}
	id, err := client.Enqueue(context.Background(), rhinoq.JobRequest{
		QueueName: "demo", JobName: "demo", Payload: []byte("{}"), IdempotencyKey: "demo:1",
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
		QueueName: "demo", States: []string{"pending"}, Limit: 10,
	})
	if err != nil || len(jobs) != 1 || jobs[0].ID != id {
		t.Fatalf("expected public job listing, jobs=%+v err=%v", jobs, err)
	}
}

func TestPublicClientRejectsNegativeRunAfter(t *testing.T) {
	client := rhinoq.NewInMemory()
	if _, err := client.Enqueue(context.Background(), rhinoq.JobRequest{
		QueueName: "demo", JobName: "demo", Payload: []byte("{}"), RunAfter: -time.Second,
	}); err == nil {
		t.Fatal("negative run-after must be rejected instead of using ambiguous wall-clock behavior")
	}
}

func TestPublicClientRefusesToRunWithoutHandlers(t *testing.T) {
	client := rhinoq.NewInMemory()
	if err := client.Run(context.Background()); err == nil {
		t.Fatal("a worker without handlers must not claim arbitrary queues")
	}
}

func TestPublicClientCapsRemoteClaimBatches(t *testing.T) {
	client := rhinoq.NewInMemory()
	if _, err := client.ClaimJobs(context.Background(), rhinoq.ClaimRequest{
		Worker: "oversized-worker",
		Limit:  1001,
	}); err == nil {
		t.Fatal("a remote worker must not create an unbounded claim transaction")
	}
}

func TestPublicClientCapsSubscribedQueuesPerWorker(t *testing.T) {
	client := rhinoq.NewInMemory()
	handler := func(context.Context, rhinoq.Job) error { return nil }
	for index := 0; index < 256; index++ {
		if err := client.Handle(fmt.Sprintf("queue-%03d", index), "demo", handler); err != nil {
			t.Fatalf("register handler %d: %v", index, err)
		}
	}
	if err := client.Handle("queue-overflow", "demo", handler); err == nil {
		t.Fatal("a worker must not build an unbounded queue filter")
	}
}
