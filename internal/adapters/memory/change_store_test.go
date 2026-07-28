package memory

import (
	"context"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/change"
	"github.com/madebyduy/RhinoQ/internal/domain/correlation"
)

func TestChangeStoreUsesStableCompositeCursor(t *testing.T) {
	store := NewChangeStore()
	ctx := context.Background()
	at := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	for _, subjectID := range []string{"b", "a", "a"} {
		if _, err := store.PublishChange(ctx, change.Record{
			Subject:   correlation.SubjectRef{Type: "report", ID: subjectID},
			ChangedAt: at,
		}); err != nil {
			t.Fatal(err)
		}
	}
	first, err := store.ListPendingChanges(ctx, change.Cursor{}, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 2 || first[0].Subject.ID != "a" ||
		first[1].Subject.ID != "a" || first[0].ID >= first[1].ID {
		t.Fatalf("timestamp ties must order by subject and sequence: %+v", first)
	}
	second, err := store.ListPendingChanges(ctx, change.Cursor{
		ChangedAt: at, SubjectID: first[1].Subject.ID, Sequence: first[1].ID,
	}, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(second) != 1 || second[0].Subject.ID != "b" {
		t.Fatalf("the composite cursor must resume after the exact tie: %+v", second)
	}
}
