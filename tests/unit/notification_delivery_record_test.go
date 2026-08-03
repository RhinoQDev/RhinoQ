package unit

import (
	"testing"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/notificationdelivery"
)

// Notify is one of beta.8's two headline features and its record transitions
// were the least covered code in the release: Retry and Fail had no test at
// all. A delivery record that silently accepts an invalid transition is how a
// notification is reported as sent when it never left the process.

func TestDeliveryRequiresACompleteIdentity(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	cases := map[string]struct {
		id, event, destination string
		at                     time.Time
	}{
		"no id":          {"", "event-1", "destination-1", now},
		"no event":       {"delivery-1", "", "destination-1", now},
		"no destination": {"delivery-1", "event-1", "", now},
		"blank id":       {"   ", "event-1", "destination-1", now},
		"zero time":      {"delivery-1", "event-1", "destination-1", time.Time{}},
	}
	for name, input := range cases {
		input := input
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := notificationdelivery.New(input.id, input.event, input.destination, input.at); err == nil {
				t.Fatal("an incomplete delivery identity must be refused")
			}
		})
	}
}

func TestNewDeliveryStartsPendingOnItsFirstAttempt(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	record, err := notificationdelivery.New("delivery-1", "event-1", "destination-1", now)
	if err != nil {
		t.Fatal(err)
	}
	if record.State != notificationdelivery.Pending || record.Attempts != 1 || record.Version != 1 {
		t.Fatalf("a new delivery must be pending on attempt 1 at version 1: %+v", record)
	}
	if !record.SentAt.IsZero() {
		t.Fatalf("nothing has been sent yet: %+v", record)
	}
}

// Only a failed delivery may retry. Retrying a pending one would double-send:
// the first attempt is still in flight.
func TestOnlyAFailedDeliveryRetries(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	pending, err := notificationdelivery.New("delivery-1", "event-1", "destination-1", now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pending.Retry(now.Add(time.Minute)); err == nil {
		t.Fatal("a pending delivery must not be retried while its attempt is in flight")
	}

	sent, err := pending.Complete(now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sent.Retry(now.Add(time.Minute)); err == nil {
		t.Fatal("a sent delivery must not be retried; that is a second notification")
	}
}

func TestRetryClearsTheErrorAndCountsTheAttempt(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	record, err := notificationdelivery.New("delivery-1", "event-1", "destination-1", now)
	if err != nil {
		t.Fatal(err)
	}
	failed, err := record.Fail("webhook returned 503", now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}

	retried, err := failed.Retry(now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if retried.State != notificationdelivery.Pending {
		t.Fatalf("a retry must return the delivery to pending, got %s", retried.State)
	}
	if retried.Attempts != 2 {
		t.Fatalf("the retry must be counted; an uncounted retry hides a destination that always fails: %+v", retried)
	}
	if retried.LastError != "" {
		t.Fatalf("the previous error belongs to the previous attempt: %q", retried.LastError)
	}
	if retried.Version != failed.Version+1 {
		t.Fatalf("every transition must advance the version: %d -> %d", failed.Version, retried.Version)
	}
	if !retried.UpdatedAt.Equal(now.Add(time.Minute)) {
		t.Fatalf("the retry must stamp its own time: %v", retried.UpdatedAt)
	}
	if _, err := failed.Retry(time.Time{}); err == nil {
		t.Fatal("a retry without a time must be refused")
	}
}

func TestFailureRequiresAPendingDeliveryAndAReason(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	record, err := notificationdelivery.New("delivery-1", "event-1", "destination-1", now)
	if err != nil {
		t.Fatal(err)
	}

	// A reason is what an operator reads to decide whether the destination is
	// broken or the payload is. Recording a failure without one is a dead end.
	if _, err := record.Fail("   ", now.Add(time.Second)); err == nil {
		t.Fatal("a failure without a reason must be refused")
	}
	if _, err := record.Fail("webhook returned 503", time.Time{}); err == nil {
		t.Fatal("a failure without a time must be refused")
	}

	failed, err := record.Fail("webhook returned 503", now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if failed.State != notificationdelivery.Failed || failed.LastError != "webhook returned 503" {
		t.Fatalf("the failure must be recorded with its reason: %+v", failed)
	}
	if _, err := failed.Fail("webhook returned 500", now.Add(2*time.Second)); err == nil {
		t.Fatal("a failed delivery must be retried before it can fail again")
	}

	sent, err := record.Complete(now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sent.Fail("too late", now.Add(2*time.Second)); err == nil {
		t.Fatal("a sent delivery must not be rewritten as failed")
	}
}

// Completion is idempotent because a duplicated confirmation is the expected
// shape of an at-least-once transport, not an error to escalate.
func TestCompletingASentDeliveryIsANoOp(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	record, err := notificationdelivery.New("delivery-1", "event-1", "destination-1", now)
	if err != nil {
		t.Fatal(err)
	}
	sent, err := record.Complete(now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}

	again, err := sent.Complete(now.Add(time.Minute))
	if err != nil {
		t.Fatalf("repeating a completion must not error: %v", err)
	}
	if again.Version != sent.Version || !again.SentAt.Equal(sent.SentAt) {
		t.Fatalf("a repeated completion must change nothing: %+v vs %+v", again, sent)
	}

	if _, err := record.Complete(time.Time{}); err == nil {
		t.Fatal("a completion without a time must be refused")
	}
	failed, err := record.Fail("webhook returned 503", now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := failed.Complete(now.Add(time.Minute)); err == nil {
		t.Fatal("a failed delivery must be retried before it can complete")
	}
}
