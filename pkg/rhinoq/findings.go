package rhinoq

import (
	"context"
	"errors"
	"time"

	findingapp "github.com/madebyduy/RhinoQ/internal/application/findings"
	"github.com/madebyduy/RhinoQ/internal/domain/finding"
)

const (
	FindingOpen           = "open"
	FindingAcknowledged   = "acknowledged"
	FindingRepairProposed = "repair_proposed"
	FindingRepairing      = "repairing"
	FindingResolved       = "resolved"
	FindingFalsePositive  = "false_positive"
	FindingIgnored        = "ignored"
	FindingRegressed      = "regressed"
)

type FindingKey struct {
	RuleID           string `json:"ruleId"`
	SubjectType      string `json:"subjectType"`
	SubjectID        string `json:"subjectId"`
	InvariantVersion int    `json:"invariantVersion"`
}

type FindingObservation struct {
	FindingKey
	Evidence   string    `json:"evidence,omitempty"`
	ObservedAt time.Time `json:"observedAt,omitempty"`
}

type FindingRecord struct {
	FindingKey
	Status          string    `json:"status"`
	FirstSeen       time.Time `json:"firstSeen"`
	LastSeen        time.Time `json:"lastSeen"`
	OccurrenceCount int       `json:"occurrenceCount"`
	LatestEvidence  string    `json:"latestEvidence,omitempty"`
	Actor           string    `json:"actor,omitempty"`
	Reason          string    `json:"reason,omitempty"`
	SuppressedUntil time.Time `json:"suppressedUntil,omitempty"`
	ResolvedAt      time.Time `json:"resolvedAt,omitempty"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

type FindingTransition struct {
	Status string    `json:"status"`
	Actor  string    `json:"actor"`
	Reason string    `json:"reason,omitempty"`
	Until  time.Time `json:"until,omitempty"`
	At     time.Time `json:"at,omitempty"`
}

type FindingQuery struct {
	RuleID            string   `json:"ruleId,omitempty"`
	SubjectType       string   `json:"subjectType,omitempty"`
	SubjectID         string   `json:"subjectId,omitempty"`
	Statuses          []string `json:"statuses,omitempty"`
	IncludeSuppressed bool     `json:"includeSuppressed,omitempty"`
	Offset            int      `json:"offset"`
	Limit             int      `json:"limit"`
}

type FindingEvent struct {
	Sequence int64 `json:"sequence"`
	FindingKey
	Kind       string    `json:"kind"`
	FromStatus string    `json:"fromStatus,omitempty"`
	ToStatus   string    `json:"toStatus"`
	Actor      string    `json:"actor,omitempty"`
	Reason     string    `json:"reason,omitempty"`
	Evidence   string    `json:"evidence,omitempty"`
	Until      time.Time `json:"until,omitempty"`
	OccurredAt time.Time `json:"occurredAt"`
}

func (c *Client) ObserveFinding(
	ctx context.Context,
	observation FindingObservation,
) (FindingRecord, error) {
	service, err := c.findingService()
	if err != nil {
		return FindingRecord{}, err
	}
	record, err := service.Observe(ctx, finding.Observation{
		Key:      findingKey(observation.FindingKey),
		Evidence: observation.Evidence, ObservedAt: observation.ObservedAt,
	})
	return summarizeFinding(record), err
}

func (c *Client) TransitionFinding(
	ctx context.Context,
	key FindingKey,
	transition FindingTransition,
) (FindingRecord, error) {
	service, err := c.findingService()
	if err != nil {
		return FindingRecord{}, err
	}
	record, err := service.Transition(ctx, findingKey(key), finding.Transition{
		Status: finding.Status(transition.Status), Actor: transition.Actor,
		Reason: transition.Reason, Until: transition.Until, At: transition.At,
	})
	return summarizeFinding(record), err
}

func (c *Client) ListFindings(
	ctx context.Context,
	query FindingQuery,
) ([]FindingRecord, error) {
	service, err := c.findingService()
	if err != nil {
		return nil, err
	}
	statuses := make([]finding.Status, 0, len(query.Statuses))
	for _, status := range query.Statuses {
		statuses = append(statuses, finding.Status(status))
	}
	records, err := service.List(ctx, finding.Query{
		RuleID: query.RuleID, SubjectType: query.SubjectType,
		SubjectID: query.SubjectID, Statuses: statuses,
		IncludeSuppressed: query.IncludeSuppressed,
		Offset:            query.Offset, Limit: query.Limit,
	})
	if err != nil {
		return nil, err
	}
	result := make([]FindingRecord, 0, len(records))
	for _, record := range records {
		result = append(result, summarizeFinding(record))
	}
	return result, nil
}

func (c *Client) FindingHistory(
	ctx context.Context,
	key FindingKey,
	offset, limit int,
) ([]FindingEvent, error) {
	service, err := c.findingService()
	if err != nil {
		return nil, err
	}
	events, err := service.History(ctx, findingKey(key), offset, limit)
	if err != nil {
		return nil, err
	}
	result := make([]FindingEvent, 0, len(events))
	for _, event := range events {
		result = append(result, FindingEvent{
			Sequence: event.Sequence, FindingKey: publicFindingKey(event.Key),
			Kind: event.Kind, FromStatus: string(event.FromStatus),
			ToStatus: string(event.ToStatus), Actor: event.Actor,
			Reason: event.Reason, Evidence: event.Evidence,
			Until: event.Until, OccurredAt: event.OccurredAt,
		})
	}
	return result, nil
}

func (c *Client) findingService() (*findingapp.Service, error) {
	if c == nil || c.findings == nil {
		return nil, errors.New("rhinoq finding store is not configured")
	}
	return findingapp.New(c.findings, func() time.Time { return time.Now().UTC() })
}

func findingKey(key FindingKey) finding.Key {
	return finding.Key{
		RuleID: key.RuleID, SubjectType: key.SubjectType,
		SubjectID: key.SubjectID, ObservedInvariantVersion: key.InvariantVersion,
	}
}

func publicFindingKey(key finding.Key) FindingKey {
	return FindingKey{
		RuleID: key.RuleID, SubjectType: key.SubjectType,
		SubjectID: key.SubjectID, InvariantVersion: key.ObservedInvariantVersion,
	}
}

func summarizeFinding(record finding.Record) FindingRecord {
	return FindingRecord{
		FindingKey: publicFindingKey(record.Key), Status: string(record.Status),
		FirstSeen: record.FirstSeen, LastSeen: record.LastSeen,
		OccurrenceCount: record.OccurrenceCount,
		LatestEvidence:  record.LatestEvidence, Actor: record.Actor,
		Reason: record.Reason, SuppressedUntil: record.SuppressedUntil,
		ResolvedAt: record.ResolvedAt, UpdatedAt: record.UpdatedAt,
	}
}
