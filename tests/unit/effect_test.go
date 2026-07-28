package unit

import (
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/effect"
)

func TestEffectConfirmationPolicy(t *testing.T) {
	record, err := effect.NewRecord("effect_1", "job_1", "create-video", "job_1:create-video", false, fixedTime())
	if err != nil {
		t.Fatal(err)
	}

	accepted, err := record.Confirm(effect.ConfirmationPolicy{Kind: effect.Predicate, CompletedStatus: "completed"}, "processing")
	if err != nil || accepted.State != effect.Pending {
		t.Fatalf("accepted processing result must remain pending: state=%s err=%v", accepted.State, err)
	}
	confirmed, err := accepted.Confirm(effect.ConfirmationPolicy{Kind: effect.Predicate, CompletedStatus: "completed"}, "completed")
	if err != nil || confirmed.State != effect.Confirmed {
		t.Fatalf("completed result must be confirmed: state=%s err=%v", confirmed.State, err)
	}
}

func fixedTime() time.Time {
	return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
}
