package queuewatch

import (
	"context"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/ports"
)

type fakeStore struct {
	ports.JobStore
	health ports.QueueHealth
}

func (s fakeStore) QueueHealth(context.Context, string) (ports.QueueHealth, error) {
	return s.health, nil
}

func TestWatchdogEmitsAtRiskAndStuckTransitions(t *testing.T) {
	now := time.Date(2026, 8, 11, 12, 0, 0, 0, time.UTC)
	store := fakeStore{health: ports.QueueHealth{
		QueueName: "imports", Pending: 2,
		OldestPendingAt: now.Add(-2 * time.Minute),
	}}
	var alerts []Alert
	watchdog, err := New(Config{
		Store: store, Queues: []string{"imports"}, Interval: time.Minute,
		AtRiskAfter: time.Minute, StuckAfter: 3 * time.Minute, Now: func() time.Time { return now },
		OnAlert: func(alert Alert) { alerts = append(alerts, alert) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := watchdog.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(alerts) != 1 || alerts[0].Kind != AtRisk || !alerts[0].Active {
		t.Fatalf("at-risk transition: %+v", alerts)
	}

	store.health.OldestPendingAt = now.Add(-4 * time.Minute)
	watchdog.store = store
	if _, err := watchdog.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(alerts) != 2 || alerts[1].Kind != Stuck || !alerts[1].Active {
		t.Fatalf("stuck transition: %+v", alerts)
	}

	store.health.Pending = 0
	store.health.OldestPendingAt = time.Time{}
	watchdog.store = store
	if _, err := watchdog.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(alerts) != 4 || alerts[2].Kind != Stuck || alerts[2].Active || alerts[3].Kind != AtRisk || alerts[3].Active {
		t.Fatalf("resolution transitions: %+v", alerts)
	}
}

func TestWatchdogDoesNotRepeatTheSameAlert(t *testing.T) {
	now := time.Date(2026, 8, 11, 12, 0, 0, 0, time.UTC)
	store := fakeStore{health: ports.QueueHealth{QueueName: "imports", Pending: 1, OldestPendingAt: now.Add(-2 * time.Minute)}}
	count := 0
	watchdog, err := New(Config{Store: store, Queues: []string{"imports"}, Interval: time.Minute,
		AtRiskAfter: time.Minute, StuckAfter: 3 * time.Minute, Now: func() time.Time { return now },
		OnAlert: func(Alert) { count++ }})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := watchdog.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := watchdog.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("repeated samples must not page repeatedly: %d", count)
	}
}
