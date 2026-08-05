package fault_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/adapters/memory"
	"github.com/madebyduy/RhinoQ/internal/application/notifications"
	"github.com/madebyduy/RhinoQ/internal/domain/notificationdelivery"
)

func TestNotificationSchedulerTakesOverOnlyAfterLeaseExpiry(t *testing.T) {
	now := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
	store := memory.NewNotificationDeliveryStore()
	record, err := notificationdelivery.New("delivery-fault", "event-fault", "ops", now)
	if err != nil {
		t.Fatal(err)
	}
	record.Payload = `{"message":"hello"}`
	if _, created, err := store.BeginNotificationDelivery(context.Background(), record); err != nil || !created {
		t.Fatalf("begin created=%v err=%v", created, err)
	}
	if _, claimed, err := store.ClaimNotificationDelivery(context.Background(), "node-a", now, time.Minute); err != nil || !claimed {
		t.Fatalf("node-a claim=%v err=%v", claimed, err)
	}

	scheduler, err := notifications.NewScheduler(notifications.SchedulerOptions{
		Store: store, Owner: "node-b", Lease: time.Minute, Now: func() time.Time { return now },
		Send: func(context.Context, notificationdelivery.Record) error {
			return errors.New("should not send while leased")
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := scheduler.RunOnce(context.Background())
	if err != nil || claimed {
		t.Fatalf("leased work was duplicated: claimed=%v err=%v", claimed, err)
	}

	now = now.Add(2 * time.Minute)
	scheduler, err = notifications.NewScheduler(notifications.SchedulerOptions{
		Store: store, Owner: "node-b", Lease: time.Minute, Now: func() time.Time { return now },
		Send: func(context.Context, notificationdelivery.Record) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err = scheduler.RunOnce(context.Background())
	if err != nil || !claimed {
		t.Fatalf("expired lease was not taken over: claimed=%v err=%v", claimed, err)
	}
	stored, _, err := store.BeginNotificationDelivery(context.Background(), record)
	if err != nil {
		t.Fatal(err)
	}
	if stored.State != notificationdelivery.Sent || stored.LeaseOwner != "" {
		t.Fatalf("takeover did not complete cleanly: %+v", stored)
	}
}
