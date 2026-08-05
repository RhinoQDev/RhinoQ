package notifications

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/adapters/memory"
	"github.com/madebyduy/RhinoQ/internal/domain/notificationdelivery"
)

func TestSchedulerPersistsBackoffAndRetriesAcrossClaims(t *testing.T) {
	now := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
	store := memory.NewNotificationDeliveryStore()
	record, err := notificationdelivery.New("delivery-1", "event-1", "ops", now)
	if err != nil {
		t.Fatal(err)
	}
	record.Payload = `{"message":"hello"}`
	if _, created, err := store.BeginNotificationDelivery(context.Background(), record); err != nil || !created {
		t.Fatalf("begin created=%v err=%v", created, err)
	}
	attempts := 0
	scheduler, err := NewScheduler(SchedulerOptions{
		Store: store, Owner: "node-a", Lease: time.Minute, MaxAttempts: 3,
		Now: func() time.Time { return now }, Backoff: func(int) time.Duration { return 0 },
		Send: func(context.Context, notificationdelivery.Record) error {
			attempts++
			if attempts == 1 {
				return errors.New("receiver unavailable")
			}
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := scheduler.RunOnce(context.Background())
	if !claimed || err == nil {
		t.Fatalf("first run claimed=%v err=%v", claimed, err)
	}
	stored, _, err := store.BeginNotificationDelivery(context.Background(), record)
	if err != nil {
		t.Fatal(err)
	}
	if stored.State != notificationdelivery.Failed || stored.Attempts != 1 {
		t.Fatalf("failed record=%+v", stored)
	}
	claimed, err = scheduler.RunOnce(context.Background())
	if !claimed || err != nil {
		t.Fatalf("second run claimed=%v err=%v", claimed, err)
	}
	stored, _, err = store.BeginNotificationDelivery(context.Background(), record)
	if err != nil {
		t.Fatal(err)
	}
	if stored.State != notificationdelivery.Sent || stored.Attempts != 2 || !stored.LeaseUntil.IsZero() {
		t.Fatalf("sent record=%+v", stored)
	}
}

func TestSchedulerDeadLettersAfterBoundedAttempts(t *testing.T) {
	now := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
	store := memory.NewNotificationDeliveryStore()
	record, err := notificationdelivery.New("delivery-2", "event-2", "ops", now)
	if err != nil {
		t.Fatal(err)
	}
	record.Payload = `{"message":"hello"}`
	_, _, _ = store.BeginNotificationDelivery(context.Background(), record)
	scheduler, err := NewScheduler(SchedulerOptions{
		Store: store, Owner: "node-a", Lease: time.Minute, MaxAttempts: 1,
		Now: func() time.Time { return now }, Send: func(context.Context, notificationdelivery.Record) error {
			return errors.New("permanent receiver failure")
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := scheduler.RunOnce(context.Background())
	if !claimed || err == nil {
		t.Fatalf("run claimed=%v err=%v", claimed, err)
	}
	stored, _, err := store.BeginNotificationDelivery(context.Background(), record)
	if err != nil {
		t.Fatal(err)
	}
	if stored.State != notificationdelivery.Dead || stored.Attempts != 1 {
		t.Fatalf("dead record=%+v", stored)
	}
}

func TestSchedulerRefusesMissingPayloadBeforeSender(t *testing.T) {
	now := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
	store := memory.NewNotificationDeliveryStore()
	record, err := notificationdelivery.New("delivery-missing-payload", "event-missing-payload", "ops", now)
	if err != nil {
		t.Fatal(err)
	}
	if _, created, err := store.BeginNotificationDelivery(context.Background(), record); err != nil || !created {
		t.Fatalf("begin created=%v err=%v", created, err)
	}
	senderCalls := 0
	scheduler, err := NewScheduler(SchedulerOptions{
		Store: store, Owner: "node-a", Lease: time.Minute, MaxAttempts: 1,
		Now: func() time.Time { return now }, Send: func(context.Context, notificationdelivery.Record) error {
			senderCalls++
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := scheduler.RunOnce(context.Background())
	if !claimed || err == nil || senderCalls != 0 {
		t.Fatalf("missing payload claimed=%v err=%v senderCalls=%d", claimed, err, senderCalls)
	}
	stored, _, err := store.BeginNotificationDelivery(context.Background(), record)
	if err != nil {
		t.Fatal(err)
	}
	if stored.State != notificationdelivery.Dead || stored.LastError == "" {
		t.Fatalf("missing payload was not dead-lettered: %+v", stored)
	}
}
