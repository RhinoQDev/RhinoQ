package rhinoq

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	adapter "github.com/madebyduy/RhinoQ/internal/adapters/notification"
	app "github.com/madebyduy/RhinoQ/internal/application/notifications"
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
