package notifications

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"

	notificationcontract "github.com/madebyduy/RhinoQ/internal/contracts/notification"
	"github.com/madebyduy/RhinoQ/internal/domain/finding"
	"github.com/madebyduy/RhinoQ/internal/domain/notificationdelivery"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

type Service struct {
	findings   ports.FindingStore
	sender     ports.NotificationSender
	deliveries ports.NotificationDeliveryStore
	now        func() time.Time
}

type Options struct {
	IncludeEvidence bool
	DestinationID   string
	GracePeriod     time.Duration
	FindingBaseURL  string
}
type Result struct {
	Message notificationcontract.Message
	Status  string
}

func New(findings ports.FindingStore, deliveries ports.NotificationDeliveryStore, sender ports.NotificationSender, now func() time.Time) (*Service, error) {
	if findings == nil || deliveries == nil || sender == nil {
		return nil, errors.New("finding store, notification delivery store and sender are required")
	}
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &Service{findings: findings, deliveries: deliveries, sender: sender, now: now}, nil
}

func (s *Service) SendFinding(ctx context.Context, key finding.Key, options Options) (Result, error) {
	record, message, err := s.prepareFinding(ctx, key, options)
	if err != nil {
		return Result{}, err
	}
	if options.GracePeriod > 0 && record.Status != finding.Regressed && s.now().Before(record.FirstSeen.Add(options.GracePeriod)) {
		return Result{Message: message, Status: "deferred"}, nil
	}
	deliveryHash := sha256.Sum256([]byte(message.ID + "\x00" + options.DestinationID))
	delivery, err := notificationdelivery.New("delivery_"+hex.EncodeToString(deliveryHash[:16]), message.ID, options.DestinationID, s.now())
	if err != nil {
		return Result{}, err
	}
	payload, err := json.Marshal(message)
	if err != nil {
		return Result{}, err
	}
	delivery.Payload = string(payload)
	delivery, created, err := s.deliveries.BeginNotificationDelivery(ctx, delivery)
	if err != nil {
		return Result{}, err
	}
	if !created && delivery.State == notificationdelivery.Sent {
		return Result{Message: message, Status: "deduplicated"}, nil
	}
	if delivery.State == notificationdelivery.Failed {
		next, retryErr := delivery.Retry(s.now())
		if retryErr != nil {
			return Result{}, retryErr
		}
		delivery, err = s.deliveries.SaveNotificationDelivery(ctx, next, delivery.Version)
		if err != nil {
			return Result{}, err
		}
	}
	if err = s.sender.Send(ctx, message); err != nil {
		failed, _ := delivery.Fail(err.Error(), s.now())
		_, _ = s.deliveries.SaveNotificationDelivery(ctx, failed, delivery.Version)
		return Result{Message: message, Status: "failed"}, err
	}
	completed, err := delivery.Complete(s.now())
	if err != nil {
		return Result{}, err
	}
	if _, err = s.deliveries.SaveNotificationDelivery(ctx, completed, delivery.Version); err != nil {
		return Result{}, err
	}
	return Result{Message: message, Status: "sent"}, nil
}

// QueueFinding creates the durable delivery record without contacting the
// receiver. A scheduler can claim it from PostgreSQL, so the request path no
// longer has to be the process that performs the network call.
func (s *Service) QueueFinding(ctx context.Context, key finding.Key, options Options) (Result, error) {
	record, message, err := s.prepareFinding(ctx, key, options)
	if err != nil {
		return Result{}, err
	}
	if options.GracePeriod > 0 && record.Status != finding.Regressed && s.now().Before(record.FirstSeen.Add(options.GracePeriod)) {
		return Result{Message: message, Status: "deferred"}, nil
	}
	deliveryHash := sha256.Sum256([]byte(message.ID + "\x00" + options.DestinationID))
	delivery, err := notificationdelivery.New("delivery_"+hex.EncodeToString(deliveryHash[:16]), message.ID, options.DestinationID, s.now())
	if err != nil {
		return Result{}, err
	}
	payload, err := json.Marshal(message)
	if err != nil {
		return Result{}, err
	}
	delivery.Payload = string(payload)
	delivery, created, err := s.deliveries.BeginNotificationDelivery(ctx, delivery)
	if err != nil {
		return Result{}, err
	}
	if !created && delivery.State == notificationdelivery.Sent {
		return Result{Message: message, Status: "deduplicated"}, nil
	}
	if delivery.State == notificationdelivery.Failed {
		next, retryErr := delivery.Retry(s.now())
		if retryErr != nil {
			return Result{}, retryErr
		}
		delivery, err = s.deliveries.SaveNotificationDelivery(ctx, next, delivery.Version)
		if err != nil {
			return Result{}, err
		}
	}
	return Result{Message: message, Status: "queued"}, nil
}

func (s *Service) prepareFinding(ctx context.Context, key finding.Key, options Options) (finding.Record, notificationcontract.Message, error) {
	record, found, err := s.findings.GetFinding(ctx, key)
	if err != nil {
		return finding.Record{}, notificationcontract.Message{}, err
	}
	if !found {
		return finding.Record{}, notificationcontract.Message{}, ports.ErrFindingNotFound
	}
	hash := sha256.Sum256([]byte(record.Key.String() + "\x00" + string(record.Status) + "\x00" + record.UpdatedAt.UTC().Format(time.RFC3339Nano)))
	message := notificationcontract.Message{ID: "finding_" + hex.EncodeToString(hash[:16]), Type: "rhinoq.finding.updated",
		RuleID: record.RuleID, SubjectType: record.SubjectType, SubjectID: record.SubjectID,
		InvariantVersion: record.ObservedInvariantVersion, Status: string(record.Status),
		OccurrenceCount: record.OccurrenceCount, ObservedAt: record.UpdatedAt}
	message.Severity, message.Escalation = findingSeverity(record.Status)
	message.Link = findingLink(options.FindingBaseURL, record)
	if options.IncludeEvidence {
		message.Evidence = record.LatestEvidence
	}
	return record, message, nil
}

func findingSeverity(status finding.Status) (string, bool) {
	switch status {
	case finding.Regressed:
		return "critical", true
	case finding.Open, finding.Repairing:
		return "high", false
	case finding.Acknowledged, finding.RepairProposed:
		return "medium", false
	default:
		return "info", false
	}
}

func findingLink(base string, record finding.Record) string {
	if strings.TrimSpace(base) == "" {
		return ""
	}
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	query := parsed.Query()
	query.Set("subjectType", record.SubjectType)
	query.Set("subjectId", record.SubjectID)
	query.Set("ruleId", record.RuleID)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}
