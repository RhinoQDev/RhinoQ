package main

import (
	"context"
	"fmt"
	"time"

	"github.com/rhinoq/rhinoq/pkg/rhinoq"
)

func main() {
	queue := rhinoq.NewInMemory()
	done := make(chan struct{}, 2)
	if err := queue.Handle("send-welcome", func(_ context.Context, job rhinoq.Job) error {
		fmt.Printf("processed %s (%s) attempt=%d\n", job.Name, job.ID, job.Attempts)
		done <- struct{}{}
		return nil
	}); err != nil {
		panic(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Higher priority runs first inside a queue; equal priorities stay FIFO.
	if _, err := queue.Enqueue(ctx, rhinoq.JobRequest{
		Name: "send-welcome", Payload: []byte(`{"userId":"u-1"}`),
		IdempotencyKey: "welcome:u-1",
	}); err != nil {
		panic(err)
	}
	if _, err := queue.Enqueue(ctx, rhinoq.JobRequest{
		Name: "send-welcome", Payload: []byte(`{"userId":"u-2"}`),
		IdempotencyKey: "welcome:u-2", Priority: 10, Class: rhinoq.ClassCritical,
	}); err != nil {
		panic(err)
	}

	stopped := make(chan error, 1)
	go func() { stopped <- queue.Run(ctx) }()

	for received := 0; received < 2; received++ {
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

	counts, err := queue.JobCounts(context.Background(), "send-welcome")
	if err != nil {
		panic(err)
	}
	fmt.Printf("succeeded=%d\n", counts["succeeded"])
}
