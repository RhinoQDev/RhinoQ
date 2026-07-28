// Package subjectoutcome holds the canonical materialized integrity state for
// one Rule version and one business subject.
package subjectoutcome

import (
	"errors"
	"strings"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/rule"
)

type Key struct {
	RuleID      string
	RuleVersion int
	SubjectType string
	SubjectID   string
}

func (k Key) Validate() error {
	if strings.TrimSpace(k.RuleID) == "" || k.RuleVersion < 1 ||
		strings.TrimSpace(k.SubjectType) == "" ||
		strings.TrimSpace(k.SubjectID) == "" {
		return errors.New("subject outcome requires a Rule version and subject")
	}
	return nil
}

type Record struct {
	Key
	Status         rule.ObservationStatus
	Reason         string
	Evidence       string
	FirstUnknownAt time.Time
	LastObservedAt time.Time
	UnknownCount   int
	UpdatedAt      time.Time
}

// Apply folds the latest observation into the materialized state. Unknown
// streak metadata resets as soon as the Rule reaches a conclusion.
func Apply(
	existing Record,
	found bool,
	key Key,
	observation rule.Observation,
	observedAt time.Time,
) (Record, error) {
	if err := key.Validate(); err != nil {
		return Record{}, err
	}
	if err := observation.Validate(); err != nil {
		return Record{}, err
	}
	if observedAt.IsZero() {
		return Record{}, errors.New("subject outcome observation time is required")
	}
	record := existing
	if !found {
		record.Key = key
	}
	record.Status = observation.Status
	record.Reason = observation.Reason
	record.Evidence = observation.Evidence
	record.LastObservedAt = observedAt
	record.UpdatedAt = observedAt
	if observation.Status == rule.Unknown {
		if !found || existing.Status != rule.Unknown || existing.FirstUnknownAt.IsZero() {
			record.FirstUnknownAt = observedAt
			record.UnknownCount = 1
		} else {
			record.UnknownCount = existing.UnknownCount + 1
		}
	} else {
		record.FirstUnknownAt = time.Time{}
		record.UnknownCount = 0
	}
	return record, nil
}

func (r Record) UnknownEscalationDue(grace time.Duration, now time.Time) bool {
	return r.Status == rule.Unknown && !r.FirstUnknownAt.IsZero() &&
		(grace <= 0 || !now.Before(r.FirstUnknownAt.Add(grace)))
}
