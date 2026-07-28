package job

import (
	"errors"
	"time"
)

var (
	ErrNilPayload      = errors.New("job payload is required")
	ErrPayloadTooLarge = errors.New("job payload exceeds configured size limit")
	ErrInvalidState    = errors.New("invalid initial job state")
	ErrInvalidPriority = errors.New("job priority must be between -100 and 100")
)

const DefaultMaxPayloadBytes = 1 << 20

const (
	MinPriority = -100
	MaxPriority = 100
)

func ValidatePayload(payload []byte, maxBytes int) error {
	if payload == nil {
		return ErrNilPayload
	}
	if maxBytes <= 0 {
		return errors.New("payload size limit must be positive")
	}
	if len(payload) > maxBytes {
		return ErrPayloadTooLarge
	}
	return nil
}

type ID string

func (id ID) String() string { return string(id) }

// BlockedReason explains why a job was parked instead of retried. It is written
// only together with State == Blocked.
type BlockedReason string

const (
	BlockedUnclassified BlockedReason = "unclassified_error"
	BlockedPoisonJob    BlockedReason = "poison_job"
)

type Record struct {
	ID ID
	// Identity is embedded, so a record exposes QueueName, JobName, GroupKey
	// and ResourceClass directly.
	Identity
	Payload         []byte
	State           State
	Priority        int
	Attempts        int
	CrashCount      int
	BlockedReason   BlockedReason
	IdempotencyKey  string
	CorrelationID   string
	CreatedAt       time.Time
	NotBefore       time.Time
	LeaseOwner      string
	LeaseEpoch      int64
	LeaseUntil      time.Time
	CancelRequested bool
}

// Spec is the validated input required to admit a new job into storage.
type Spec struct {
	ID ID
	Identity
	Payload   []byte
	Now       time.Time
	NotBefore time.Time
	Priority  int
}

func NewRecord(spec Spec) (Record, error) {
	identity, err := spec.Identity.Normalize()
	if err != nil {
		return Record{}, err
	}
	if err := ValidatePayload(spec.Payload, DefaultMaxPayloadBytes); err != nil {
		return Record{}, err
	}
	if spec.ID == "" || spec.Now.IsZero() {
		return Record{}, ErrInvalidState
	}
	if spec.Priority < MinPriority || spec.Priority > MaxPriority {
		return Record{}, ErrInvalidPriority
	}
	notBefore := spec.NotBefore
	if notBefore.IsZero() {
		notBefore = spec.Now
	}
	return Record{
		ID:        spec.ID,
		Identity:  identity,
		Payload:   append([]byte(nil), spec.Payload...),
		State:     Pending,
		Priority:  spec.Priority,
		CreatedAt: spec.Now,
		NotBefore: notBefore,
	}, nil
}
