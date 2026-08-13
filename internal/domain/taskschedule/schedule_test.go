package taskschedule

import (
	"testing"
	"time"
)

func TestNewNormalizesAndUsesDatabaseSuppliedNow(t *testing.T) {
	now := time.Date(2026, 8, 13, 1, 2, 3, 0, time.FixedZone("local", 7*3600))
	record, err := New(Spec{ID: " daily-report ", TaskName: " report.export ", OwnerID: " owner-a ", TenantID: " tenant-a ", Every: time.Hour}, now)
	if err != nil {
		t.Fatal(err)
	}
	if record.ID != "daily-report" || record.TaskName != "report.export" || record.OwnerID != "owner-a" {
		t.Fatalf("not normalized: %#v", record)
	}
	if !record.NextRunAt.Equal(now) || record.NextRunAt.Location() != time.UTC {
		t.Fatalf("unexpected next run: %v", record.NextRunAt)
	}
}

func TestIntervalBoundsAndLeaseFence(t *testing.T) {
	if _, err := New(Spec{ID: "x", TaskName: "x", OwnerID: "x", Every: time.Second}, time.Now()); err == nil {
		t.Fatal("accepted unsafe interval")
	}
	lease := Lease{ScheduleID: "s", TaskName: "t", OwnerID: "o", TenantID: "tenant", Occurrence: time.Now(), Every: time.Minute, LeaseOwner: "replica-a", Epoch: 1, ExpiresAt: time.Now().Add(time.Minute)}
	if err := lease.Validate(); err != nil {
		t.Fatal(err)
	}
	lease.Epoch = 0
	if err := lease.Validate(); err == nil {
		t.Fatal("accepted unfenced lease")
	}
}

func TestOccurrenceIdentityIsStableAndScheduleScoped(t *testing.T) {
	at := time.Date(2026, 8, 13, 0, 0, 0, 0, time.UTC)
	one, _ := OccurrenceID("tenant", "schedule-a", at)
	replay, _ := OccurrenceID("tenant", "schedule-a", at.In(time.FixedZone("other", 3600)))
	other, _ := OccurrenceID("tenant", "schedule-b", at)
	if one != replay || one == other {
		t.Fatalf("identity mismatch: %q %q %q", one, replay, other)
	}
}
