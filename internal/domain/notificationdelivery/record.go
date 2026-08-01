package notificationdelivery

import (
	"errors"
	"strings"
	"time"
)

type State string

const (
	Pending State = "pending"
	Sent    State = "sent"
	Failed  State = "failed"
)

type Record struct {
	ID, EventID, DestinationID   string
	State                        State
	Attempts                     int
	Version                      int64
	LastError                    string
	CreatedAt, UpdatedAt, SentAt time.Time
}

func New(id, eventID, destinationID string, now time.Time) (Record, error) {
	if strings.TrimSpace(id) == "" || strings.TrimSpace(eventID) == "" || strings.TrimSpace(destinationID) == "" || now.IsZero() {
		return Record{}, errors.New("notification delivery requires id, event, destination and time")
	}
	return Record{ID: id, EventID: eventID, DestinationID: destinationID, State: Pending, Attempts: 1, Version: 1, CreatedAt: now, UpdatedAt: now}, nil
}

func (r Record) Retry(now time.Time) (Record, error) {
	if r.State != Failed || now.IsZero() {
		return r, errors.New("only a failed notification may retry")
	}
	r.State, r.LastError, r.UpdatedAt = Pending, "", now
	r.Attempts++
	r.Version++
	return r, nil
}
func (r Record) Complete(now time.Time) (Record, error) {
	if r.State == Sent {
		return r, nil
	}
	if r.State != Pending || now.IsZero() {
		return r, errors.New("notification is not pending")
	}
	r.State, r.SentAt, r.UpdatedAt = Sent, now, now
	r.Version++
	return r, nil
}
func (r Record) Fail(reason string, now time.Time) (Record, error) {
	if r.State != Pending || strings.TrimSpace(reason) == "" || now.IsZero() {
		return r, errors.New("notification failure requires a pending delivery and reason")
	}
	r.State, r.LastError, r.UpdatedAt = Failed, reason, now
	r.Version++
	return r, nil
}
