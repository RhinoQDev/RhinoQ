package ports

import (
	"context"

	"github.com/madebyduy/RhinoQ/internal/domain/change"
)

type ChangeStore interface {
	PublishChange(ctx context.Context, record change.Record) (change.Record, error)
	ListPendingChanges(
		ctx context.Context,
		cursor change.Cursor,
		limit int,
	) ([]change.Record, error)
	CompleteChange(ctx context.Context, id int64) error
	FailChange(ctx context.Context, id int64, message string) error
}
