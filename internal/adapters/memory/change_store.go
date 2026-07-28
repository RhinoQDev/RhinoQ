package memory

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/change"
)

type ChangeStore struct {
	mu      sync.Mutex
	nextID  int64
	records map[int64]change.Record
}

func NewChangeStore() *ChangeStore {
	return &ChangeStore{records: make(map[int64]change.Record)}
}

func (s *ChangeStore) PublishChange(
	_ context.Context,
	record change.Record,
) (change.Record, error) {
	if err := record.Validate(); err != nil {
		return change.Record{}, err
	}
	normalized, err := record.Subject.Normalize()
	if err != nil {
		return change.Record{}, err
	}
	record.Subject = normalized
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextID++
	record.ID = s.nextID
	if record.CreatedAt.IsZero() {
		record.CreatedAt = time.Now().UTC()
	}
	s.records[record.ID] = record
	return record, nil
}

func (s *ChangeStore) ListPendingChanges(
	_ context.Context,
	cursor change.Cursor,
	limit int,
) ([]change.Record, error) {
	if !cursor.Valid() || limit <= 0 || limit > 1000 {
		return nil, errors.New("invalid change cursor or limit")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	records := make([]change.Record, 0, len(s.records))
	for _, record := range s.records {
		if !record.ProcessedAt.IsZero() || !afterCursor(record, cursor) {
			continue
		}
		records = append(records, record)
	}
	sort.Slice(records, func(i, j int) bool {
		if !records[i].ChangedAt.Equal(records[j].ChangedAt) {
			return records[i].ChangedAt.Before(records[j].ChangedAt)
		}
		if records[i].Subject.ID != records[j].Subject.ID {
			return records[i].Subject.ID < records[j].Subject.ID
		}
		return records[i].ID < records[j].ID
	})
	if len(records) > limit {
		records = records[:limit]
	}
	return append([]change.Record(nil), records...), nil
}

func afterCursor(record change.Record, cursor change.Cursor) bool {
	if cursor.ChangedAt.IsZero() {
		return true
	}
	if record.ChangedAt.After(cursor.ChangedAt) {
		return true
	}
	if !record.ChangedAt.Equal(cursor.ChangedAt) {
		return false
	}
	if record.Subject.ID > cursor.SubjectID {
		return true
	}
	return record.Subject.ID == cursor.SubjectID && record.ID > cursor.Sequence
}

func (s *ChangeStore) CompleteChange(_ context.Context, id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	record, found := s.records[id]
	if !found {
		return errors.New("change not found")
	}
	record.ProcessedAt = time.Now().UTC()
	record.LastError = ""
	s.records[id] = record
	return nil
}

func (s *ChangeStore) FailChange(_ context.Context, id int64, message string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	record, found := s.records[id]
	if !found {
		return errors.New("change not found")
	}
	record.LastError = message
	s.records[id] = record
	return nil
}
