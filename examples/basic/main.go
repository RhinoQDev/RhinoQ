package main

import (
	"context"
	"fmt"
	"time"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

func main() {
	queue := rhinoq.NewInMemory()
	done := make(chan struct{}, 3)

	// Two unrelated contracts share one execution lane. They therefore share a
	// worker pool, a rate limit and an admission budget, which is the point of
	// separating the lane from the handler contract.
	if err := queue.Handle("notifications", "send-welcome", func(_ context.Context, job rhinoq.Job) error {
		fmt.Printf("processed %s/%s (%s) attempt=%d\n",
			job.QueueName, job.JobName, job.ID, job.Attempts)
		done <- struct{}{}
		return nil
	}); err != nil {
		panic(err)
	}
	if err := queue.Handle("notifications", "send-receipt", func(_ context.Context, job rhinoq.Job) error {
		fmt.Printf("processed %s/%s (%s) tenant=%s\n",
			job.QueueName, job.JobName, job.ID, job.GroupKey)
		done <- struct{}{}
		return nil
	}); err != nil {
		panic(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Higher priority runs first inside a lane; equal priorities stay FIFO.
	if _, err := queue.Enqueue(ctx, rhinoq.JobRequest{
		QueueName: "notifications", JobName: "send-welcome",
		Payload:        []byte(`{"userId":"u-1"}`),
		IdempotencyKey: "welcome:u-1",
	}); err != nil {
		panic(err)
	}
	if _, err := queue.Enqueue(ctx, rhinoq.JobRequest{
		QueueName: "notifications", JobName: "send-welcome",
		Payload:        []byte(`{"userId":"u-2"}`),
		IdempotencyKey: "welcome:u-2", Priority: 10,
		ResourceClass: rhinoq.ResourceCritical,
	}); err != nil {
		panic(err)
	}
	if _, err := queue.Enqueue(ctx, rhinoq.JobRequest{
		QueueName: "notifications", JobName: "send-receipt",
		GroupKey:       "tenant-42",
		Payload:        []byte(`{"orderId":"o-9"}`),
		IdempotencyKey: "receipt:o-9",
	}); err != nil {
		panic(err)
	}

	stopped := make(chan error, 1)
	go func() { stopped <- queue.Run(ctx) }()

	for received := 0; received < 3; received++ {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			panic("jobs were not processed in time")
		}
	}

	// Cancelling the context starts the graceful shutdown: the worker stops
	// claiming, lets running handlers finish, and only then returns.
	cancel()
	if err := <-stopped; err != nil && err != context.Canceled {
		panic(err)
	}

	// Counts are per lane, so this covers both contracts above.
	counts, err := queue.JobCounts(context.Background(), "notifications")
	if err != nil {
		panic(err)
	}
	fmt.Printf("succeeded=%d\n", counts["succeeded"])
}
