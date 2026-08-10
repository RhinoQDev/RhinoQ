package tasks

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/task"
	"github.com/madebyduy/RhinoQ/internal/domain/waitpoint"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

const maxWaitpointResolutionBytes = 64 << 10

type CreateWaitpointInput struct {
	ID, TaskID, Key string
	Kind            waitpoint.Kind
	SchemaVersion   int
	Deadline        time.Time
}

type ResolveWaitpointInput struct {
	ID, OwnerID, ResolutionID, Actor string
	ExpectedVersion                  int64
	Resolution                       []byte
}

type CancelWaitpointInput struct {
	ID, OwnerID     string
	ExpectedVersion int64
}

func (s *Service) waitpointStore() (ports.WaitpointStore, error) {
	store, ok := s.tasks.(ports.WaitpointStore)
	if !ok {
		return nil, errors.New("task store does not support durable waitpoints")
	}
	return store, nil
}

func (s *Service) CreateWaitpoint(ctx context.Context, input CreateWaitpointInput) (waitpoint.Record, bool, error) {
	store, err := s.waitpointStore()
	if err != nil {
		return waitpoint.Record{}, false, err
	}
	if _, found, err := s.tasks.GetTask(ctx, task.ID(strings.TrimSpace(input.TaskID))); err != nil {
		return waitpoint.Record{}, false, err
	} else if !found {
		return waitpoint.Record{}, false, ports.ErrTaskNotFound
	}
	record, err := waitpoint.New(waitpoint.Spec{ID: input.ID, TaskID: input.TaskID, Key: input.Key, Kind: input.Kind, SchemaVersion: input.SchemaVersion, Deadline: input.Deadline, Now: s.now()})
	if err != nil {
		return waitpoint.Record{}, false, err
	}
	return store.CreateWaitpoint(ctx, record)
}

func (s *Service) GetWaitpoint(ctx context.Context, id waitpoint.ID, ownerID string) (waitpoint.Record, error) {
	store, err := s.waitpointStore()
	if err != nil {
		return waitpoint.Record{}, err
	}
	record, found, err := store.GetWaitpoint(ctx, id)
	if err != nil {
		return waitpoint.Record{}, err
	}
	if !found {
		return waitpoint.Record{}, ports.ErrWaitpointNotFound
	}
	parent, found, err := s.tasks.GetTask(ctx, task.ID(record.TaskID))
	if err != nil {
		return waitpoint.Record{}, err
	}
	// Hide existence across owners with the same not-found response.
	if !found || strings.TrimSpace(ownerID) == "" || parent.OwnerID != strings.TrimSpace(ownerID) {
		return waitpoint.Record{}, ports.ErrWaitpointNotFound
	}
	return record, nil
}

func (s *Service) ResolveWaitpoint(ctx context.Context, input ResolveWaitpointInput) (waitpoint.Record, error) {
	if input.ExpectedVersion <= 0 || len(input.Resolution) == 0 || len(input.Resolution) > maxWaitpointResolutionBytes || !json.Valid(input.Resolution) {
		return waitpoint.Record{}, errors.New("valid waitpoint version and JSON resolution up to 64 KiB are required")
	}
	current, err := s.GetWaitpoint(ctx, waitpoint.ID(input.ID), input.OwnerID)
	if err != nil {
		return waitpoint.Record{}, err
	}
	// Duplicate command identity is allowed to replay even after the caller's version became stale.
	if current.State != waitpoint.Resolved && current.Version != input.ExpectedVersion {
		return waitpoint.Record{}, ports.ErrVersionConflict
	}
	sum := sha256.Sum256(input.Resolution)
	next, err := current.Resolve(input.Resolution, hex.EncodeToString(sum[:]), input.ResolutionID, input.Actor, s.now())
	if err != nil {
		return waitpoint.Record{}, err
	}
	if current.State == waitpoint.Resolved {
		return next, nil
	}
	store, err := s.waitpointStore()
	if err != nil {
		return waitpoint.Record{}, err
	}
	return store.UpdateWaitpoint(ctx, next, current.Version)
}

func (s *Service) CancelWaitpoint(ctx context.Context, input CancelWaitpointInput) (waitpoint.Record, error) {
	current, err := s.GetWaitpoint(ctx, waitpoint.ID(input.ID), input.OwnerID)
	if err != nil {
		return waitpoint.Record{}, err
	}
	if input.ExpectedVersion <= 0 || current.Version != input.ExpectedVersion {
		return waitpoint.Record{}, ports.ErrVersionConflict
	}
	next, err := current.Cancel(s.now())
	if err != nil {
		return waitpoint.Record{}, err
	}
	store, err := s.waitpointStore()
	if err != nil {
		return waitpoint.Record{}, err
	}
	return store.UpdateWaitpoint(ctx, next, current.Version)
}

// ExpireDueWaitpoints is a bounded scheduler tick. Concurrent ticks are safe:
// only one version-fenced update wins and losers ignore that conflict.
func (s *Service) ExpireDueWaitpoints(ctx context.Context, limit int) (int, error) {
	store, err := s.waitpointStore()
	if err != nil {
		return 0, err
	}
	now := s.now()
	due, err := store.ListDueWaitpoints(ctx, now, limit)
	if err != nil {
		return 0, err
	}
	expired := 0
	for _, current := range due {
		next, transitionErr := current.Expire(now)
		if transitionErr != nil {
			continue
		}
		if _, updateErr := store.UpdateWaitpoint(ctx, next, current.Version); updateErr == nil {
			expired++
		} else if !errors.Is(updateErr, ports.ErrVersionConflict) {
			return expired, updateErr
		}
	}
	return expired, nil
}
