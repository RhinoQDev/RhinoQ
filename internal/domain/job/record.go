package job

import (
	"errors"
	"time"
)

var (
	ErrEmptyName    = errors.New("job name is required")
	ErrNilPayload   = errors.New("job payload is required")
	ErrInvalidState = errors.New("invalid initial job state")
)

type ID string

type Record struct {
	ID             ID
	Name           string
	Payload        []byte
	State          State
	Attempts       int
	IdempotencyKey string
	CorrelationID  string
	CreatedAt      time.Time
	NotBefore      time.Time
	LeaseID        string
	LeaseUntil     time.Time
}

func NewRecord(id ID, name string, payload []byte, now, notBefore time.Time) (Record, error) {
	if name == "" {
		return Record{}, ErrEmptyName
	}
	if payload == nil {
		return Record{}, ErrNilPayload
	}
	if id == "" || now.IsZero() {
		return Record{}, ErrInvalidState
	}
	if notBefore.IsZero() {
		notBefore = now
	}
	return Record{
		ID:        id,
		Name:      name,
		Payload:   append([]byte(nil), payload...),
		State:     Pending,
		CreatedAt: now,
		NotBefore: notBefore,
	}, nil
}
