package task

import "testing"

func TestTaskLifecycleTransitions(t *testing.T) {
	valid := []struct {
		from State
		to   State
	}{
		{Pending, Queued},
		{Queued, Running},
		{Running, Failed},
		{Failed, Queued},
		{Running, CancelRequested},
		{CancelRequested, Cancelled},
		{Queued, Cancelled},
	}
	for _, tc := range valid {
		if !CanTransition(tc.from, tc.to) {
			t.Errorf("expected transition %s -> %s to be valid", tc.from, tc.to)
		}
	}

	invalid := []struct {
		from State
		to   State
	}{
		{Pending, Running},
		{Succeeded, Queued},
		{Succeeded, Failed},
		{Cancelled, Running},
	}
	for _, tc := range invalid {
		if CanTransition(tc.from, tc.to) {
			t.Errorf("expected transition %s -> %s to be invalid", tc.from, tc.to)
		}
	}
}

func TestRecordProgressSupportsKnownAndUnknownTotals(t *testing.T) {
	if !(Progress{Completed: 3, Total: 10, HasTotal: true}).Valid() {
		t.Fatal("known-total progress should be valid")
	}
	if !(Progress{Completed: 3, Message: "processing"}).Valid() {
		t.Fatal("indeterminate progress should be valid")
	}
	if (Progress{Completed: 11, Total: 10, HasTotal: true}).Valid() {
		t.Fatal("completed work cannot exceed its known total")
	}
}
