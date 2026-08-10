package provideroperations

import (
	"context"
	"errors"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/provideroperation"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

type Service struct {
	store ports.ProviderOperationStore
	now   func() time.Time
}

func New(store ports.ProviderOperationStore, now func() time.Time) (*Service, error) {
	if store == nil {
		return nil, errors.New("provider operation store is required")
	}
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &Service{store: store, now: now}, nil
}

func (s *Service) Begin(ctx context.Context, id provideroperation.ID, taskID, provider, operation, key string, confirmation provideroperation.ConfirmationPolicy, retryPolicy provideroperation.RetryPolicy) (provideroperation.Record, error) {
	return s.BeginWithFingerprint(ctx, id, taskID, provider, operation, key, "", confirmation, retryPolicy)
}

func (s *Service) BeginWithFingerprint(ctx context.Context, id provideroperation.ID, taskID, provider, operation, key, fingerprint string, confirmation provideroperation.ConfirmationPolicy, retryPolicy provideroperation.RetryPolicy) (provideroperation.Record, error) {
	record, err := provideroperation.NewWithFingerprint(id, taskID, provider, operation, key, fingerprint, confirmation, retryPolicy, s.now())
	if err != nil {
		return provideroperation.Record{}, err
	}
	stored, err := s.store.BeginProviderOperation(ctx, record)
	if err == nil && (stored.TaskID != record.TaskID || stored.RequestFingerprint != record.RequestFingerprint || stored.Confirmation != record.Confirmation || stored.RetryPolicy != record.RetryPolicy) {
		return stored, errors.New("provider operation idempotency key was reused with a different task, request fingerprint or policy")
	}
	return stored, err
}

func (s *Service) Get(ctx context.Context, id provideroperation.ID) (provideroperation.Record, error) {
	record, found, err := s.store.GetProviderOperation(ctx, id)
	if err != nil {
		return record, err
	}
	if !found {
		return record, ports.ErrProviderOperationNotFound
	}
	return record, nil
}

func (s *Service) Accept(ctx context.Context, record provideroperation.Record, providerID, evidence string) (provideroperation.Record, error) {
	return s.mutate(ctx, record, "accepted", evidence, func(r provideroperation.Record) (provideroperation.Record, error) {
		return r.Accept(providerID, s.now())
	})
}
func (s *Service) Confirm(ctx context.Context, record provideroperation.Record, evidence string) (provideroperation.Record, error) {
	return s.mutate(ctx, record, "confirmed", evidence, func(r provideroperation.Record) (provideroperation.Record, error) {
		return r.Confirm(evidence, s.now())
	})
}
func (s *Service) Resolve(ctx context.Context, record provideroperation.Record, state provideroperation.State, reason string) (provideroperation.Record, error) {
	return s.mutate(ctx, record, "resolution", reason, func(r provideroperation.Record) (provideroperation.Record, error) {
		return r.Resolve(state, reason, s.now())
	})
}
func (s *Service) Retry(ctx context.Context, record provideroperation.Record) (provideroperation.Record, error) {
	return s.mutate(ctx, record, "retry_authorized", "provider proved the previous request did not happen", func(r provideroperation.Record) (provideroperation.Record, error) { return r.Retry(s.now()) })
}
func (s *Service) Evidence(ctx context.Context, id provideroperation.ID) ([]provideroperation.Evidence, error) {
	if _, err := s.Get(ctx, id); err != nil {
		return nil, err
	}
	return s.store.ListProviderOperationEvidence(ctx, id)
}

// Attention returns a bounded, oldest-first batch that is safe for a verifier
// to inspect. It never authorizes replaying the external mutation.
func (s *Service) Attention(ctx context.Context, before time.Time, limit int) ([]provideroperation.Record, error) {
	return s.store.ListProviderOperations(ctx, []provideroperation.State{
		provideroperation.Pending, provideroperation.Accepted, provideroperation.Uncertain,
	}, before, limit)
}
func (s *Service) ByTask(ctx context.Context, taskID string, limit int) ([]provideroperation.Record, error) {
	return s.store.ListProviderOperationsByTask(ctx, taskID, limit)
}
func (s *Service) mutate(ctx context.Context, current provideroperation.Record, evidenceKind, evidencePayload string, fn func(provideroperation.Record) (provideroperation.Record, error)) (provideroperation.Record, error) {
	next, err := fn(current)
	if err != nil {
		return current, err
	}
	if next.Version == current.Version {
		return current, nil
	}
	var evidence *provideroperation.Evidence
	if evidencePayload != "" {
		evidence = &provideroperation.Evidence{OperationID: current.ID, Kind: evidenceKind, Payload: evidencePayload, CreatedAt: s.now()}
		next.Evidence = evidencePayload
	}
	return s.store.SaveProviderOperation(ctx, next, current.Version, evidence)
}
