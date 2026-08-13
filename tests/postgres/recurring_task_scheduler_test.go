package postgres_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	adapter "github.com/madebyduy/RhinoQ/internal/adapters/postgres"
	"github.com/madebyduy/RhinoQ/internal/domain/taskschedule"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

func TestRecurringScheduleLeaseTakeoverPreservesOccurrenceAndFence(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	truncate(t)
	ctx := context.Background()
	storeA, err := adapter.NewTaskScheduleStore(testDB)
	if err != nil {
		t.Fatal(err)
	}
	storeB, err := adapter.NewTaskScheduleStore(testDB)
	if err != nil {
		t.Fatal(err)
	}
	now := databaseNow(t)
	record, err := taskschedule.New(taskschedule.Spec{
		ID: "hourly-report", TenantID: "tnt_system", OwnerID: "owner-a", TaskName: "report.export",
		Payload: json.RawMessage(`{"reportId":"r1"}`), Every: time.Hour, StartAt: now.Add(-time.Second),
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = storeA.SaveTaskSchedule(ctx, record); err != nil {
		t.Fatal(err)
	}

	first, err := storeA.ClaimDueTaskSchedules(ctx, "replica-a", now, 120*time.Millisecond, 1)
	if err != nil || len(first) != 1 {
		t.Fatalf("first claim len=%d err=%v", len(first), err)
	}
	if blocked, err := storeB.ClaimDueTaskSchedules(ctx, "replica-b", now, 120*time.Millisecond, 1); err != nil || len(blocked) != 0 {
		t.Fatalf("live lease was stolen len=%d err=%v", len(blocked), err)
	}
	firstID, _ := taskschedule.OccurrenceID(first[0].TenantID, first[0].ScheduleID, first[0].Occurrence)
	time.Sleep(180 * time.Millisecond)
	second, err := storeB.ClaimDueTaskSchedules(ctx, "replica-b", now, 120*time.Millisecond, 1)
	if err != nil || len(second) != 1 {
		t.Fatalf("takeover len=%d err=%v", len(second), err)
	}
	secondID, _ := taskschedule.OccurrenceID(second[0].TenantID, second[0].ScheduleID, second[0].Occurrence)
	if firstID != secondID || second[0].Epoch <= first[0].Epoch {
		t.Fatalf("occurrence/fence changed first=%q/%d second=%q/%d", firstID, first[0].Epoch, secondID, second[0].Epoch)
	}
	if err := storeB.CompleteTaskSchedule(ctx, second[0], second[0].Occurrence.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := storeA.CompleteTaskSchedule(ctx, first[0], first[0].Occurrence.Add(time.Hour)); !errors.Is(err, ports.ErrLeaseLost) {
		t.Fatalf("stale completion=%v", err)
	}
	got, ok, err := storeA.GetTaskSchedule(ctx, "tnt_system", "hourly-report")
	if err != nil || !ok {
		t.Fatalf("read ok=%v err=%v", ok, err)
	}
	if !got.NextRunAt.Equal(first[0].Occurrence.Add(time.Hour)) {
		t.Fatalf("next run=%v", got.NextRunAt)
	}
	stats, err := storeA.TaskScheduleStats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stats.Enabled != 1 || stats.Due != 0 || stats.Leased != 0 || stats.Failed != 0 {
		t.Fatalf("stats=%#v", stats)
	}
}

func TestRecurringCronTimezonePersistsAndAdvancesAcrossDST(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	truncate(t)
	ctx := context.Background()
	store, _ := adapter.NewTaskScheduleStore(testDB)
	now := time.Date(2026, 3, 8, 6, 0, 0, 0, time.UTC)
	record, err := taskschedule.New(taskschedule.Spec{ID: "daily-local", TenantID: "tnt_system", OwnerID: "owner", TaskName: "report.export", Payload: json.RawMessage(`{}`), Cron: "30 2 * * *", Timezone: "America/New_York"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.SaveTaskSchedule(ctx, record); err != nil {
		t.Fatal(err)
	}
	loaded, ok, err := store.GetTaskSchedule(ctx, "tnt_system", "daily-local")
	if err != nil || !ok || loaded.Cron != "30 2 * * *" || loaded.Timezone != "America/New_York" {
		t.Fatalf("loaded=%#v ok=%v err=%v", loaded, ok, err)
	}
	if want := time.Date(2026, 3, 9, 6, 30, 0, 0, time.UTC); !loaded.NextRunAt.Equal(want) {
		t.Fatalf("next=%s want=%s", loaded.NextRunAt, want)
	}
}

func TestRecurringScheduleFailureBackoffKeepsOccurrence(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	truncate(t)
	ctx := context.Background()
	store, _ := adapter.NewTaskScheduleStore(testDB)
	now := databaseNow(t)
	record, _ := taskschedule.New(taskschedule.Spec{ID: "retry", TenantID: "tnt_system", OwnerID: "owner", TaskName: "task", Payload: json.RawMessage(`{}`), Every: time.Hour, StartAt: now.Add(-time.Second)}, now)
	if _, err := store.SaveTaskSchedule(ctx, record); err != nil {
		t.Fatal(err)
	}
	first, err := store.ClaimDueTaskSchedules(ctx, "a", now, 50*time.Millisecond, 1)
	if err != nil || len(first) != 1 {
		t.Fatalf("claim err=%v", err)
	}
	if err := store.FailTaskSchedule(ctx, first[0], 120*time.Millisecond, "runtime unavailable"); err != nil {
		t.Fatal(err)
	}
	stats, err := store.TaskScheduleStats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stats.Failed != 1 || stats.Leased != 1 {
		t.Fatalf("failed stats=%#v", stats)
	}
	if stats.OldestDueLag <= 0 {
		t.Fatalf("oldest due lag=%v", stats.OldestDueLag)
	}
	if got, _ := store.ClaimDueTaskSchedules(ctx, "b", now, 50*time.Millisecond, 1); len(got) != 0 {
		t.Fatal("backoff was ignored")
	}
	// Keep a wide margin over the database-clock backoff. A narrow 50 ms
	// margin flakes under Windows/Docker scheduling without indicating an early claim.
	time.Sleep(350 * time.Millisecond)
	second, err := store.ClaimDueTaskSchedules(ctx, "b", now, 50*time.Millisecond, 1)
	if err != nil || len(second) != 1 {
		t.Fatalf("reclaim len=%d err=%v", len(second), err)
	}
	if !second[0].Occurrence.Equal(first[0].Occurrence) {
		t.Fatal("failure created a different occurrence")
	}
}
