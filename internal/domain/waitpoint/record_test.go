package waitpoint

import (
	"errors"
	"testing"
	"time"
)

func TestResolveIsIdempotentButRejectsConflictingInput(t *testing.T) {
	now := time.Date(2026, 8, 9, 1, 0, 0, 0, time.UTC)
	r, err := New(Spec{ID: "wp-1", TaskID: "task-1", Key: "review", Kind: Approval, SchemaVersion: 1, Deadline: now.Add(time.Hour), Now: now})
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := r.Resolve([]byte(`{"approved":true}`), "hash", "command-1", "user-1", now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := resolved.Resolve([]byte(`{"approved":true}`), "hash", "command-1", "user-1", now.Add(2*time.Minute))
	if err != nil || replayed.Version != resolved.Version {
		t.Fatalf("replay changed record: %#v %v", replayed, err)
	}
	_, err = resolved.Resolve([]byte(`{"approved":false}`), "other", "command-2", "user-1", now.Add(2*time.Minute))
	if !errors.Is(err, ErrResolutionConflict) {
		t.Fatalf("got %v", err)
	}
}

func TestWaitpointExpiresAtDeadlineAndCannotResolve(t *testing.T) {
	now := time.Date(2026, 8, 9, 1, 0, 0, 0, time.UTC)
	r, _ := New(Spec{ID: "wp-1", TaskID: "task-1", Key: "input", Kind: Input, SchemaVersion: 1, Deadline: now.Add(time.Minute), Now: now})
	expired, err := r.Expire(now.Add(time.Minute))
	if err != nil || expired.State != Expired {
		t.Fatalf("expire: %#v %v", expired, err)
	}
	_, err = expired.Resolve([]byte(`{}`), "hash", "command", "user", now.Add(2*time.Minute))
	if !errors.Is(err, ErrAlreadySettled) {
		t.Fatalf("got %v", err)
	}
}
