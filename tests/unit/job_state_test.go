package unit

import (
	"testing"

	"github.com/rhinoq/rhinoq/internal/domain/job"
)

func TestJobStateTransitions(t *testing.T) {
	valid := [][2]job.State{
		{job.Pending, job.Leased},
		{job.Leased, job.Succeeded},
		{job.Leased, job.RetryWait},
		{job.RetryWait, job.Leased},
		{job.Blocked, job.Leased},
	}
	for _, pair := range valid {
		if !job.CanTransition(pair[0], pair[1]) {
			t.Fatalf("expected transition %s -> %s to be valid", pair[0], pair[1])
		}
	}

	if job.CanTransition(job.Succeeded, job.Leased) {
		t.Fatal("terminal job must not be leased again")
	}
}
