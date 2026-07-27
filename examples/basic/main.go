package main

import (
	"context"
	"fmt"
	"time"

	"github.com/rhinoq/rhinoq/pkg/rhinoq"
)

func main() {
	queue := rhinoq.NewInMemory()
	if err := queue.Handle("send-welcome", func(_ context.Context, job rhinoq.Job) error {
		fmt.Printf("processed %s (%s) attempt=%d\n", job.Name, job.ID, job.Attempts)
		return nil
	}); err != nil {
		panic(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if _, err := queue.Enqueue(ctx, "send-welcome", []byte(`{"userId":"u-1"}`), "welcome:u-1"); err != nil {
		panic(err)
	}

	go func() {
		if err := queue.Run(ctx); err != nil && err != context.Canceled {
			panic(err)
		}
	}()
	time.Sleep(100 * time.Millisecond)
	cancel()
}
