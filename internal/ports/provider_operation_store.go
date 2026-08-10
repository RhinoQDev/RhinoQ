package ports

import (
	"context"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/provideroperation"
)

type ProviderOperationStore interface {
	BeginProviderOperation(context.Context, provideroperation.Record) (provideroperation.Record, error)
	GetProviderOperation(context.Context, provideroperation.ID) (provideroperation.Record, bool, error)
	SaveProviderOperation(context.Context, provideroperation.Record, int64, *provideroperation.Evidence) (provideroperation.Record, error)
	ListProviderOperationEvidence(context.Context, provideroperation.ID) ([]provideroperation.Evidence, error)
	ListProviderOperations(context.Context, []provideroperation.State, time.Time, int) ([]provideroperation.Record, error)
}
