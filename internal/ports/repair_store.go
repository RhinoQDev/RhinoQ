package ports

import (
	"context"
	"github.com/madebyduy/RhinoQ/internal/domain/repair"
)

type RepairStore interface {
	CreateRepair(context.Context, repair.Record) (repair.Record, error)
	GetRepair(context.Context, repair.ID) (repair.Record, bool, error)
	SaveRepair(context.Context, repair.Record, int64) (repair.Record, error)
}
