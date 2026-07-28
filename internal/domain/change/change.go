package change

import (
	"errors"
	"strings"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/correlation"
)

type Record struct {
	ID          int64
	Subject     correlation.SubjectRef
	BusinessKey string
	ChangedAt   time.Time
	CreatedAt   time.Time
	ProcessedAt time.Time
	LastError   string
}

func (r Record) Validate() error {
	if _, err := r.Subject.Normalize(); err != nil {
		return err
	}
	if r.ChangedAt.IsZero() || len(r.BusinessKey) > correlation.MaxIDBytes {
		return errors.New("change requires a subject, changed time and bounded business key")
	}
	return nil
}

type Cursor struct {
	ChangedAt time.Time
	SubjectID string
	Sequence  int64
}

func (c Cursor) Valid() bool {
	empty := c.ChangedAt.IsZero() &&
		strings.TrimSpace(c.SubjectID) == "" && c.Sequence == 0
	complete := !c.ChangedAt.IsZero() &&
		strings.TrimSpace(c.SubjectID) != "" && c.Sequence > 0
	return empty || complete
}
