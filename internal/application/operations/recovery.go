package operations

import (
	"context"
	"errors"

	"github.com/rhinoq/rhinoq/internal/domain/job"
	"github.com/rhinoq/rhinoq/internal/domain/recovery"
	"github.com/rhinoq/rhinoq/internal/ports"
)

type Recovery struct{ store ports.RecoveryStore }

func NewRecovery(store ports.RecoveryStore) (*Recovery, error) {
	if store == nil {
		return nil, errors.New("recovery store is required")
	}
	return &Recovery{store: store}, nil
}

func (r *Recovery) ListAttention(ctx context.Context, query recovery.AttentionQuery) ([]recovery.AttentionItem, error) {
	return r.store.ListAttention(ctx, query)
}

func (r *Recovery) Replay(ctx context.Context, request recovery.ReplayRequest) (job.Record, recovery.AuditRecord, error) {
	return r.store.Replay(ctx, request)
}

func (r *Recovery) AuditTrail(ctx context.Context, jobID job.ID, offset, limit int) ([]recovery.AuditRecord, error) {
	return r.store.ListAudit(ctx, jobID, offset, limit)
}
