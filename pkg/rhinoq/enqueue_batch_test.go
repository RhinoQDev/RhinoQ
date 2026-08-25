package rhinoq

import (
	"context"
	"testing"
)

func TestEnqueueBatchIsAtomicOrderedAndIdempotent(t *testing.T) {
	client := NewInMemory()
	requests := []JobRequest{
		{QueueName: "media", JobName: "probe", Payload: []byte(`{"id":1}`), IdempotencyKey: "one"},
		{QueueName: "media", JobName: "transcode", Payload: []byte(`{"id":2}`), IdempotencyKey: "two"},
	}
	ids, err := client.EnqueueBatch(context.Background(), requests)
	if err != nil {
		t.Fatalf("enqueue batch: %v", err)
	}
	if len(ids) != 2 || ids[0] != "job_000001" || ids[1] != "job_000002" {
		t.Fatalf("ordered ids = %#v", ids)
	}
	replayed, err := client.EnqueueBatch(context.Background(), requests)
	if err != nil {
		t.Fatalf("replay batch: %v", err)
	}
	if replayed[0] != ids[0] || replayed[1] != ids[1] {
		t.Fatalf("replay ids = %#v", replayed)
	}

	clean := NewInMemory()
	_, err = clean.EnqueueBatch(context.Background(), []JobRequest{
		{QueueName: "media", JobName: "valid", Payload: []byte(`{}`)},
		{QueueName: "", JobName: "invalid", Payload: []byte(`{}`)},
	})
	if err == nil {
		t.Fatal("expected invalid batch to fail")
	}
	id, err := clean.Enqueue(context.Background(), JobRequest{QueueName: "media", JobName: "after", Payload: []byte(`{}`)})
	if err != nil {
		t.Fatalf("enqueue after rollback: %v", err)
	}
	if id != "job_000001" {
		t.Fatalf("batch was partially committed: next id %q", id)
	}
}
