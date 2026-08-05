package memory

import (
	"context"
	"sort"
	"sync"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/notificationdelivery"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

type NotificationDeliveryStore struct {
	mu    sync.Mutex
	byID  map[string]notificationdelivery.Record
	byKey map[string]string
}

func NewNotificationDeliveryStore() *NotificationDeliveryStore {
	return &NotificationDeliveryStore{byID: map[string]notificationdelivery.Record{}, byKey: map[string]string{}}
}

func (s *NotificationDeliveryStore) BeginNotificationDelivery(_ context.Context, record notificationdelivery.Record) (notificationdelivery.Record, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := record.EventID + "\x00" + record.DestinationID
	if id, ok := s.byKey[key]; ok {
		return s.byID[id], false, nil
	}
	s.byKey[key], s.byID[record.ID] = record.ID, record
	return record, true, nil
}

func (s *NotificationDeliveryStore) SaveNotificationDelivery(_ context.Context, record notificationdelivery.Record, expected int64) (notificationdelivery.Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.byID[record.ID]
	if !ok {
		return notificationdelivery.Record{}, ports.ErrNotificationDeliveryNotFound
	}
	if current.Version != expected || record.Version != expected+1 {
		return notificationdelivery.Record{}, ports.ErrVersionConflict
	}
	s.byID[record.ID] = record
	return record, nil
}

func (s *NotificationDeliveryStore) ClaimNotificationDelivery(_ context.Context, owner string, now time.Time, lease time.Duration) (notificationdelivery.Record, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ids := make([]string, 0, len(s.byID))
	for id := range s.byID {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		current := s.byID[id]
		if (current.State != notificationdelivery.Pending && current.State != notificationdelivery.Failed) ||
			(!current.NextAttemptAt.IsZero() && current.NextAttemptAt.After(now)) ||
			(!current.LeaseUntil.IsZero() && current.LeaseUntil.After(now)) {
			continue
		}
		claimed, err := current.Claim(owner, now, lease)
		if err != nil {
			return notificationdelivery.Record{}, false, err
		}
		s.byID[id] = claimed
		return claimed, true, nil
	}
	return notificationdelivery.Record{}, false, nil
}
