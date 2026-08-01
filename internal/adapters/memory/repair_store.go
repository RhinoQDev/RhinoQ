package memory

import (
	"context"
	"fmt"
	"github.com/madebyduy/RhinoQ/internal/domain/repair"
	"github.com/madebyduy/RhinoQ/internal/ports"
	"sync"
)

type RepairStore struct {
	mu      sync.RWMutex
	records map[repair.ID]repair.Record
}

func NewRepairStore() *RepairStore { return &RepairStore{records: map[repair.ID]repair.Record{}} }
func (s *RepairStore) CreateRepair(_ context.Context, record repair.Record) (repair.Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, current := range s.records {
		if current.FindingKey == record.FindingKey && repairIsActive(current.State) {
			return repair.Record{}, fmt.Errorf("%w: active repair for %s", ports.ErrAlreadyExists, record.FindingKey.String())
		}
	}
	if _, ok := s.records[record.ID]; ok {
		return repair.Record{}, fmt.Errorf("%w: repair %s", ports.ErrAlreadyExists, record.ID)
	}
	s.records[record.ID] = record
	return record, nil
}

func repairIsActive(state repair.State) bool {
	return state == repair.Proposed || state == repair.Previewed || state == repair.Approved || state == repair.Running
}
func (s *RepairStore) GetRepair(_ context.Context, id repair.ID) (repair.Record, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.records[id]
	return r, ok, nil
}
func (s *RepairStore) SaveRepair(_ context.Context, record repair.Record, expected int64) (repair.Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.records[record.ID]
	if !ok {
		return repair.Record{}, ports.ErrRepairNotFound
	}
	if current.Version != expected || record.Version != expected+1 {
		return repair.Record{}, ports.ErrVersionConflict
	}
	s.records[record.ID] = record
	return record, nil
}
