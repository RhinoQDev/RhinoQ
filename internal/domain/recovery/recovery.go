package recovery

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/rhinoq/rhinoq/internal/domain/effect"
	"github.com/rhinoq/rhinoq/internal/domain/job"
)

type AttentionKind string

const (
	DeadJob          AttentionKind = "dead_job"
	ExecutionBlocked AttentionKind = "execution_blocked"
	EffectUncertain  AttentionKind = "effect_uncertain"
	OutcomeMismatch  AttentionKind = "outcome_mismatch"
)

type AttentionItem struct {
	Kind        AttentionKind
	JobID       job.ID
	Queue       string
	JobState    job.State
	ReferenceID string
	Reason      string
	ObservedAt  time.Time
}

type AttentionQuery struct {
	Queue  string
	Offset int
	Limit  int
}

type ReplayRequest struct {
	JobID       job.ID
	Actor       string
	Reason      string
	RequestedAt time.Time
}

type AuditRecord struct {
	ID         string
	JobID      job.ID
	Action     string
	Actor      string
	Reason     string
	OccurredAt time.Time
	PrevHash   string
	RowHash    string
}

var (
	ErrInvalidAttentionQuery = errors.New("attention offset must be non-negative and limit must be between 1 and 1000")
	ErrInvalidReplayRequest  = errors.New("replay requires job id, actor, reason and requested time")
	ErrReplayState           = errors.New("only dead or blocked jobs can be replayed")
	ErrConfirmedEffect       = errors.New("replay denied: a confirmed effect requires resume")
	ErrUncertainEffect       = errors.New("replay denied: an uncertain effect requires operator decision")
	ErrUnresolvedEffect      = errors.New("replay denied: a pending effect is unresolved")
)

func ValidateAttentionQuery(query AttentionQuery) error {
	if query.Offset < 0 || query.Limit <= 0 || query.Limit > 1000 {
		return ErrInvalidAttentionQuery
	}
	return nil
}

func ValidateReplay(record job.Record, effects []effect.Record, request ReplayRequest) error {
	if request.JobID == "" || strings.TrimSpace(request.Actor) == "" ||
		strings.TrimSpace(request.Reason) == "" || request.RequestedAt.IsZero() {
		return ErrInvalidReplayRequest
	}
	if record.ID != request.JobID || (record.State != job.Dead && record.State != job.Blocked) {
		return ErrReplayState
	}
	for _, item := range effects {
		switch item.State {
		case effect.Confirmed:
			return ErrConfirmedEffect
		case effect.Uncertain:
			return ErrUncertainEffect
		case effect.Pending:
			return ErrUnresolvedEffect
		}
	}
	return nil
}

func HashAudit(previous string, record AuditRecord) string {
	canonical := strings.Join([]string{
		previous,
		record.ID,
		record.JobID.String(),
		record.Action,
		record.Actor,
		record.Reason,
		record.OccurredAt.UTC().Format(time.RFC3339Nano),
	}, "\n")
	sum := sha256.Sum256([]byte(canonical))
	return hex.EncodeToString(sum[:])
}
