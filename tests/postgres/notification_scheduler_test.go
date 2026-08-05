package postgres_test

import (
	"context"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

func TestNotificationSchedulerTakesOverAnExpiredPostgresLease(t *testing.T) {
	if testDB == nil {
		t.Skip("set RHINOQ_TEST_DATABASE_URL to run the PostgreSQL harness")
	}
	truncate(t)
	client, err := rhinoq.NewIntegrity(testDB)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	key := rhinoq.FindingKey{
		RuleID:           "pg-notification-scheduler",
		SubjectType:      "invoice",
		SubjectID:        "invoice-pg-1",
		InvariantVersion: 1,
	}
	if _, err := client.ObserveFinding(ctx, rhinoq.FindingObservation{
		FindingKey: key, Evidence: "missing receipt", ObservedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	receipt, err := client.QueueFindingNotification(ctx, key, rhinoq.NotificationDestination{
		URL: "https://example.invalid/rhinoq", Kind: "webhook", Secret: "test-secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Add(time.Minute)
	started := make(chan struct{})
	release := make(chan struct{})
	first, err := client.NewNotificationScheduler(rhinoq.NotificationSchedulerOptions{
		Owner: "postgres-node-a", Lease: time.Minute, Now: func() time.Time { return now },
		Send: func(context.Context, rhinoq.NotificationDelivery) error {
			close(started)
			<-release
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := client.NewNotificationScheduler(rhinoq.NotificationSchedulerOptions{
		Owner: "postgres-node-b", Lease: time.Minute, Now: func() time.Time { return now.Add(2 * time.Minute) },
		Send: func(context.Context, rhinoq.NotificationDelivery) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}

	type runResult struct {
		claimed bool
		err     error
	}
	firstResult := make(chan runResult, 1)
	go func() {
		claimed, runErr := first.RunOnce(ctx)
		firstResult <- runResult{claimed: claimed, err: runErr}
	}()
	select {
	case <-started:
	case result := <-firstResult:
		t.Fatalf("first scheduler returned before sender: claimed=%v err=%v", result.claimed, result.err)
	case <-time.After(5 * time.Second):
		t.Fatal("first scheduler did not claim the delivery")
	}

	claimed, err := second.RunOnce(ctx)
	if err != nil || !claimed {
		t.Fatalf("second scheduler takeover claimed=%v err=%v", claimed, err)
	}
	close(release)
	if result := <-firstResult; result.err == nil {
		t.Fatal("stale scheduler must lose its version fence")
	}

	var state string
	if err := testDB.QueryRowContext(ctx, `SELECT state FROM rhinoq_notification_deliveries WHERE event_id = $1`,
		receipt.ID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "sent" {
		t.Fatalf("takeover did not persist sent state: %s", state)
	}
}
