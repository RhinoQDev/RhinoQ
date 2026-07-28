package verification

import (
	"context"
	"errors"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/outcome"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

var ErrVerificationDependencyMissing = errors.New("outcome store, verifier and clock are required")

type VerifyOutcome struct {
	store    ports.OutcomeStore
	verifier ports.OutcomeVerifier
	clock    func() time.Time
}

func NewVerifyOutcome(store ports.OutcomeStore, verifier ports.OutcomeVerifier, clock func() time.Time) *VerifyOutcome {
	return &VerifyOutcome{store: store, verifier: verifier, clock: clock}
}

func (v *VerifyOutcome) Execute(ctx context.Context, record outcome.Record, contract outcome.Contract) (outcome.Record, error) {
	if v == nil || v.store == nil || v.verifier == nil || v.clock == nil {
		return record, ErrVerificationDependencyMissing
	}
	observation, err := v.verifier.Verify(ctx, record.JobID, contract)
	if err != nil {
		return record, err
	}
	updated, err := record.Apply(observation, v.clock())
	if err != nil {
		return record, err
	}
	if err := v.store.SaveOutcome(ctx, updated); err != nil {
		return record, err
	}
	return updated, nil
}
