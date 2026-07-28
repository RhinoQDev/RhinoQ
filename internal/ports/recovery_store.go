package ports

import (
	"context"

	"github.com/madebyduy/RhinoQ/internal/domain/job"
	"github.com/madebyduy/RhinoQ/internal/domain/recovery"
)

type RecoveryStore interface {
	ListAttention(ctx context.Context, query recovery.AttentionQuery) ([]recovery.AttentionItem, error)
	Replay(ctx context.Context, request recovery.ReplayRequest) (job.Record, recovery.AuditRecord, error)
	ListAudit(ctx context.Context, jobID job.ID, offset, limit int) ([]recovery.AuditRecord, error)
}
