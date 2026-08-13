package taskscheduler

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/taskschedule"
)

type store struct {
	leases            []taskschedule.Lease
	completed, failed int
}

func (s *store) GetTaskSchedule(context.Context, string, string) (taskschedule.Record, bool, error) {
	return taskschedule.Record{}, false, nil
}
func (s *store) ListTaskSchedules(context.Context, string, int) ([]taskschedule.Record, error) {
	return nil, nil
}
func (s *store) SetTaskScheduleEnabled(_ context.Context, _ string, _ string, _ int64, _ bool) (taskschedule.Record, error) {
	return taskschedule.Record{}, nil
}
func (s *store) UpdateTaskSchedule(_ context.Context, _ string, _ string, _ int64, _ time.Duration, _ time.Time) (taskschedule.Record, error) {
	return taskschedule.Record{}, nil
}
func (s *store) UpdateTaskScheduleCalendar(_ context.Context, _, _ string, _ int64, _, _ string, _ time.Time) (taskschedule.Record, error) { return taskschedule.Record{}, nil }
func (s *store) DeleteTaskSchedule(context.Context, string, string, int64) error { return nil }
func (s *store) TaskScheduleStats(context.Context) (taskschedule.Stats, error) {
	return taskschedule.Stats{}, nil
}

func (s *store) SaveTaskSchedule(_ context.Context, r taskschedule.Record) (taskschedule.Record, error) {
	return r, nil
}
func (s *store) ClaimDueTaskSchedules(context.Context, string, time.Time, time.Duration, int) ([]taskschedule.Lease, error) {
	return s.leases, nil
}
func (s *store) CompleteTaskSchedule(_ context.Context, _ taskschedule.Lease, next time.Time) error {
	s.completed++
	if next.IsZero() {
		return errors.New("next occurrence is required")
	}
	return nil
}
func (s *store) FailTaskSchedule(context.Context, taskschedule.Lease, time.Duration, string) error {
	s.failed++
	return nil
}

func TestRunOnceDispatchesStableOccurrenceThenCompletes(t *testing.T) {
	at := time.Date(2026, 8, 13, 0, 0, 0, 0, time.UTC)
	lease := taskschedule.Lease{ScheduleID: "daily", TaskName: "report.export", OwnerID: "owner", TenantID: "tenant", Occurrence: at, Every: time.Hour, LeaseOwner: "r1", Epoch: 2, ExpiresAt: at.Add(time.Minute)}
	s := &store{leases: []taskschedule.Lease{lease}}
	var id string
	runner, _ := New(Config{Store: s, Dispatch: func(_ context.Context, got taskschedule.Lease, occurrenceID string) error {
		id = occurrenceID
		if got.Epoch != 2 {
			t.Fatal("lost fence")
		}
		return nil
	}, Owner: "r1"})
	if err := runner.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	want, _ := taskschedule.OccurrenceID("tenant", "daily", at)
	if id != want || s.completed != 1 || s.failed != 0 {
		t.Fatalf("id=%q completed=%d failed=%d", id, s.completed, s.failed)
	}
}

func TestRunOnceBacksOffFailedDispatchWithoutCompleting(t *testing.T) {
	at := time.Now().UTC()
	lease := taskschedule.Lease{ScheduleID: "daily", TaskName: "report.export", OwnerID: "owner", TenantID: "tenant", Occurrence: at, Every: time.Hour, LeaseOwner: "r1", Epoch: 1, ExpiresAt: at.Add(time.Minute)}
	s := &store{leases: []taskschedule.Lease{lease}}
	failure := errors.New("runtime unavailable")
	runner, _ := New(Config{Store: s, Dispatch: func(context.Context, taskschedule.Lease, string) error { return failure }, Owner: "r1"})
	if err := runner.RunOnce(context.Background()); !errors.Is(err, failure) {
		t.Fatalf("got %v", err)
	}
	if s.completed != 0 || s.failed != 1 {
		t.Fatalf("completed=%d failed=%d", s.completed, s.failed)
	}
}
