package rhinoq

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	adapter "github.com/madebyduy/RhinoQ/internal/adapters/notification"
	app "github.com/madebyduy/RhinoQ/internal/application/notifications"
	notificationcontract "github.com/madebyduy/RhinoQ/internal/contracts/notification"
)

type NotificationDestination struct {
	URL     string
	Kind    string
	Secret  string
	Timeout time.Duration
	// IncludeEvidence is opt-in because evidence may contain business data.
	IncludeEvidence bool
	GracePeriod     time.Duration
	FindingBaseURL  string
}

type NotificationReceipt struct {
	ID       string    `json:"id"`
	Type     string    `json:"type"`
	SentAt   time.Time `json:"sentAt"`
	Status   string    `json:"status"`
	Severity string    `json:"severity"`
}

// NotificationTestType is the event type of a delivery probe. A receiver can
// match on it to drop probes, and an operator reading their inbox can tell one
// apart from a real Finding without opening it.
const NotificationTestType = "rhinoq.notification.test"

// SendTestNotification delivers one synthetic, signed event so a destination
// can be proven before it is trusted with a real Finding.
//
// A signed webhook is the one part of this system that cannot be verified by
// reading code: the secret, the URL, the receiver's signature check and its
// TLS all have to line up at the far end. It writes nothing - no delivery
// ledger row, no Finding, no database connection - so it is safe to run
// against production configuration from a laptop.
func SendTestNotification(
	ctx context.Context,
	destination NotificationDestination,
) (NotificationReceipt, error) {
	sender, err := adapter.New(adapter.Config{
		URL: destination.URL, Kind: adapter.Kind(destination.Kind),
		Secret: destination.Secret, Timeout: destination.Timeout,
	})
	if err != nil {
		return NotificationReceipt{}, err
	}
	now := time.Now().UTC()
	// The ID is derived from the destination and the minute so a receiver that
	// deduplicates on event ID still sees a repeated probe as a new event
	// within the hour, but a retry inside the same minute stays idempotent.
	sum := sha256.Sum256([]byte(
		destination.Kind + "\x00" + destination.URL + "\x00" +
			now.Format("2006-01-02T15:04"),
	))
	message := notificationcontract.Message{
		ID: "test_" + hex.EncodeToString(sum[:16]), Type: NotificationTestType,
		RuleID: "rhinoq.notification.test", SubjectType: "rhinoq",
		SubjectID: "delivery-probe", InvariantVersion: 0,
		Status: "test", Severity: "info", OccurrenceCount: 1, ObservedAt: now,
		Evidence: `{"note":"RhinoQ delivery test. No business data is included."}`,
	}
	if err := sender.Send(ctx, message); err != nil {
		return NotificationReceipt{
			ID: message.ID, Type: message.Type, SentAt: now, Status: "failed",
			Severity: message.Severity,
		}, err
	}
	return NotificationReceipt{
		ID: message.ID, Type: message.Type, SentAt: now, Status: "sent",
		Severity: message.Severity,
	}, nil
}

// SendFindingNotification sends one deterministic, idempotency-friendly event
// to a generic signed webhook or a Slack incoming webhook. Delivery is
// synchronous; callers choose their own retry policy around the stable event ID.
func (c *IntegrityClient) SendFindingNotification(ctx context.Context, key FindingKey, destination NotificationDestination) (NotificationReceipt, error) {
	sender, err := adapter.New(adapter.Config{URL: destination.URL, Kind: adapter.Kind(destination.Kind), Secret: destination.Secret, Timeout: destination.Timeout})
	if err != nil {
		return NotificationReceipt{}, err
	}
	if c == nil || c.notificationDeliveries == nil {
		return NotificationReceipt{}, errors.New("notification delivery store is not configured")
	}
	destinationHash := sha256.Sum256([]byte(destination.Kind + "\x00" + destination.URL))
	service, err := app.New(c.findings, c.notificationDeliveries, sender, nil)
	if err != nil {
		return NotificationReceipt{}, err
	}
	result, err := service.SendFinding(ctx, findingKey(key), app.Options{
		IncludeEvidence: destination.IncludeEvidence,
		DestinationID:   hex.EncodeToString(destinationHash[:16]),
		GracePeriod:     destination.GracePeriod, FindingBaseURL: destination.FindingBaseURL,
	})
	if err != nil {
		return NotificationReceipt{}, err
	}
	return NotificationReceipt{ID: result.Message.ID, Type: result.Message.Type, SentAt: time.Now().UTC(), Status: result.Status, Severity: result.Message.Severity}, nil
}
