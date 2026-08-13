// Package taskschedule owns durable recurring Task identity and lease fences.
// It contains no database, queue, runtime or framework knowledge.
package taskschedule

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

var ErrInvalid = errors.New("invalid recurring task schedule")

const (
	MinimumInterval = time.Minute
	MaximumInterval = 365 * 24 * time.Hour
)

type Spec struct {
	ID       string
	TaskName string
	OwnerID  string
	TenantID string
	Every    time.Duration
	Cron     string
	Timezone string
	StartAt  time.Time
	Payload  json.RawMessage
}

type Record struct {
	Spec
	Enabled   bool
	NextRunAt time.Time
	Version   int64
	CreatedAt time.Time
	UpdatedAt time.Time
}

type Stats struct {
	Enabled, Paused, Due, Leased, Failed int64
	OldestDueLag                         time.Duration
}

func New(spec Spec, now time.Time) (Record, error) {
	if err := spec.Validate(); err != nil || now.IsZero() {
		return Record{}, ErrInvalid
	}
	now = now.UTC()
	next := spec.StartAt.UTC()
	if spec.Cron != "" {
		anchor := now
		if !next.IsZero() {
			anchor = next.Add(-time.Minute)
		}
		var err error
		next, err = spec.NextAfter(anchor)
		if err != nil {
			return Record{}, err
		}
	} else if next.IsZero() {
		next = now
	}
	return Record{Spec: normalized(spec), Enabled: true, NextRunAt: next, Version: 1, CreatedAt: now, UpdatedAt: now}, nil
}

func (s Spec) Validate() error {
	if strings.TrimSpace(s.ID) == "" || strings.TrimSpace(s.TaskName) == "" || strings.TrimSpace(s.OwnerID) == "" || strings.TrimSpace(s.TenantID) == "" ||
		((s.Cron == "") == (s.Every == 0)) {
		return ErrInvalid
	}
	if s.Cron == "" && (s.Every < MinimumInterval || s.Every > MaximumInterval) {
		return ErrInvalid
	}
	if s.Cron != "" {
		if _, err := ParseCron(s.Cron, s.Timezone); err != nil {
			return ErrInvalid
		}
	}
	if len(s.Payload) > 1<<20 || (len(s.Payload) > 0 && !json.Valid(s.Payload)) {
		return ErrInvalid
	}
	return nil
}

type Lease struct {
	ScheduleID string
	TaskName   string
	OwnerID    string
	TenantID   string
	Occurrence time.Time
	Every      time.Duration
	Cron       string
	Timezone   string
	LeaseOwner string
	Epoch      int64
	ExpiresAt  time.Time
	Payload    json.RawMessage
}

func (l Lease) Validate() error {
	if strings.TrimSpace(l.ScheduleID) == "" || strings.TrimSpace(l.TaskName) == "" ||
		strings.TrimSpace(l.OwnerID) == "" || strings.TrimSpace(l.TenantID) == "" || strings.TrimSpace(l.LeaseOwner) == "" ||
		l.Occurrence.IsZero() || l.ExpiresAt.IsZero() || l.Epoch < 1 || ((l.Cron == "") == (l.Every == 0)) {
		return ErrInvalid
	}
	if len(l.Payload) > 1<<20 || (len(l.Payload) > 0 && !json.Valid(l.Payload)) {
		return ErrInvalid
	}
	if l.Cron == "" && (l.Every < MinimumInterval || l.Every > MaximumInterval) {
		return ErrInvalid
	}
	if l.Cron != "" {
		if _, err := ParseCron(l.Cron, l.Timezone); err != nil {
			return ErrInvalid
		}
	}
	return nil
}

func (s Spec) NextAfter(after time.Time) (time.Time, error) {
	if s.Cron != "" {
		cron, err := ParseCron(s.Cron, s.Timezone)
		if err != nil {
			return time.Time{}, err
		}
		return cron.Next(after)
	}
	if s.Every < MinimumInterval || after.IsZero() {
		return time.Time{}, ErrInvalid
	}
	return after.UTC().Add(s.Every), nil
}

// OccurrenceID is stable across scheduler replicas and lease takeovers. It is
// an idempotency identity, not a secret or authorization token.
func OccurrenceID(tenantID, scheduleID string, occurrence time.Time) (string, error) {
	if strings.TrimSpace(tenantID) == "" || strings.TrimSpace(scheduleID) == "" || occurrence.IsZero() {
		return "", ErrInvalid
	}
	sum := sha256.Sum256([]byte(strings.TrimSpace(tenantID) + "\x00" + strings.TrimSpace(scheduleID) + "\x00" + occurrence.UTC().Format(time.RFC3339Nano)))
	return "rqs_" + hex.EncodeToString(sum[:16]), nil
}

func normalized(spec Spec) Spec {
	spec.ID = strings.TrimSpace(spec.ID)
	spec.TaskName = strings.TrimSpace(spec.TaskName)
	spec.OwnerID = strings.TrimSpace(spec.OwnerID)
	spec.TenantID = strings.TrimSpace(spec.TenantID)
	spec.Cron = strings.Join(strings.Fields(spec.Cron), " ")
	spec.Timezone = strings.TrimSpace(spec.Timezone)
	if !spec.StartAt.IsZero() {
		spec.StartAt = spec.StartAt.UTC()
	}
	spec.Payload = append(json.RawMessage(nil), spec.Payload...)
	return spec
}
