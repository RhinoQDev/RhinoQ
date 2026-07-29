package execution

import "testing"

func TestExecutionLifecycle(t *testing.T) {
	valid := []struct{ from, to State }{
		{PendingDispatch, Dispatched},
		{Dispatched, Running},
		{Running, Succeeded},
		{Running, Stalled},
		{Stalled, Dispatched},
		{Dispatched, Cancelled},
	}
	for _, tc := range valid {
		if !CanTransition(tc.from, tc.to) {
			t.Errorf("expected %s -> %s to be valid", tc.from, tc.to)
		}
	}

	invalid := []struct{ from, to State }{
		{PendingDispatch, Running},
		{Succeeded, Running},
		{Failed, Dispatched},
		{Cancelled, Running},
	}
	for _, tc := range invalid {
		if CanTransition(tc.from, tc.to) {
			t.Errorf("expected %s -> %s to be invalid", tc.from, tc.to)
		}
	}
}
