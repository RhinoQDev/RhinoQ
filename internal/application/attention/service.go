// Package attention builds one operator inbox from execution failures and
// persistent business-integrity Findings.
package attention

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/finding"
	"github.com/madebyduy/RhinoQ/internal/domain/recovery"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

type Service struct {
	recovery ports.RecoveryStore
	findings ports.FindingStore
	now      func() time.Time
}

func New(
	recoveryStore ports.RecoveryStore,
	findingStore ports.FindingStore,
	now func() time.Time,
) (*Service, error) {
	if recoveryStore == nil {
		return nil, errors.New("recovery store is required")
	}
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &Service{
		recovery: recoveryStore, findings: findingStore, now: now,
	}, nil
}

func (s *Service) List(
	ctx context.Context,
	query recovery.AttentionQuery,
) ([]recovery.AttentionItem, error) {
	if err := recovery.ValidateAttentionQuery(query); err != nil {
		return nil, err
	}
	sourceLimit := query.Offset + query.Limit
	execution, err := s.listExecution(ctx, query.Queue, sourceLimit)
	if err != nil {
		return nil, err
	}
	combined := append([]recovery.AttentionItem(nil), execution...)
	// Findings are business-subject scoped and do not necessarily map to one
	// queue. A queue-filtered inbox therefore stays execution-only.
	if s.findings != nil && query.Queue == "" {
		records, err := s.listFindings(ctx, sourceLimit)
		if err != nil {
			return nil, err
		}
		for _, record := range records {
			combined = append(combined, recovery.AttentionItem{
				Kind:        recovery.IntegrityFinding,
				ReferenceID: record.Key.String(),
				Reason:      findingReason(record),
				ObservedAt:  record.LastSeen,
			})
		}
	}
	sort.SliceStable(combined, func(i, j int) bool {
		if combined[i].ObservedAt.Equal(combined[j].ObservedAt) {
			return combined[i].ReferenceID > combined[j].ReferenceID
		}
		return combined[i].ObservedAt.After(combined[j].ObservedAt)
	})
	if query.Offset >= len(combined) {
		return []recovery.AttentionItem{}, nil
	}
	end := query.Offset + query.Limit
	if end > len(combined) {
		end = len(combined)
	}
	return append([]recovery.AttentionItem(nil), combined[query.Offset:end]...), nil
}

func (s *Service) listExecution(
	ctx context.Context,
	queue string,
	count int,
) ([]recovery.AttentionItem, error) {
	result := make([]recovery.AttentionItem, 0, count)
	for len(result) < count {
		limit := min(recovery.MaxAttentionPageSize, count-len(result))
		page, err := s.recovery.ListAttention(ctx, recovery.AttentionQuery{
			Queue: queue, Offset: len(result), Limit: limit,
		})
		if err != nil {
			return nil, err
		}
		result = append(result, page...)
		if len(page) < limit {
			break
		}
	}
	return result, nil
}

func (s *Service) listFindings(
	ctx context.Context,
	count int,
) ([]finding.Record, error) {
	result := make([]finding.Record, 0, count)
	for len(result) < count {
		limit := min(recovery.MaxAttentionPageSize, count-len(result))
		page, err := s.findings.ListFindings(ctx, finding.Query{
			Statuses: []finding.Status{
				finding.Open, finding.Acknowledged, finding.RepairProposed,
				finding.Repairing, finding.Regressed,
			},
			Now: s.now(), Offset: len(result), Limit: limit,
		})
		if err != nil {
			return nil, err
		}
		result = append(result, page...)
		if len(page) < limit {
			break
		}
	}
	return result, nil
}

func findingReason(record finding.Record) string {
	switch record.Status {
	case finding.Regressed:
		return "business invariant regressed after it had been resolved"
	case finding.Acknowledged:
		return "business invariant is acknowledged and still unresolved"
	case finding.RepairProposed:
		return "business invariant has a repair proposal awaiting action"
	case finding.Repairing:
		return "business invariant repair is in progress"
	default:
		return "business invariant is violated"
	}
}
