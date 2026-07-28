package rhinoq

import (
	"context"
	"errors"
	"fmt"
	"time"

	applicationeffect "github.com/madebyduy/RhinoQ/internal/application/effect"
	domaineffect "github.com/madebyduy/RhinoQ/internal/domain/effect"
)

// ConfirmPolicy is what counts as proof that an external effect finished. A
// provider returning 202 Accepted is not proof, so RhinoQ refuses to guess and
// makes the caller declare which evidence applies.
type ConfirmPolicy string

const (
	// ConfirmOnReturn is only correct when the call returning means the work is
	// done - a synchronous charge that returns a settled transaction.
	ConfirmOnReturn ConfirmPolicy = ConfirmPolicy(domaineffect.OnReturn)
	// ConfirmExternalSignal leaves the effect pending until a webhook or other
	// signal confirms it.
	ConfirmExternalSignal ConfirmPolicy = ConfirmPolicy(domaineffect.ExternalSignal)
	// ConfirmVerify leaves the effect pending until a verifier reads the
	// provider back.
	ConfirmVerify ConfirmPolicy = ConfirmPolicy(domaineffect.Verify)
	// ConfirmWhenStatus confirms only when the call returns a specific status.
	ConfirmWhenStatus ConfirmPolicy = ConfirmPolicy(domaineffect.Predicate)
)

// Effect states.
const (
	EffectPending     = string(domaineffect.Pending)
	EffectConfirmed   = string(domaineffect.Confirmed)
	EffectUncertain   = string(domaineffect.Uncertain)
	EffectRejected    = string(domaineffect.Rejected)
	EffectNotHappened = string(domaineffect.NotHappened)
)

// EffectOutcome is what a caller reports back about a provider call.
type EffectOutcome string

const (
	// EffectSucceeded applies the declared confirmation policy.
	EffectSucceeded EffectOutcome = "succeeded"
	// EffectResultUnknown is the honest answer to a timeout: the call may have
	// happened. The effect becomes uncertain and is never retried blindly.
	EffectResultUnknown EffectOutcome = "unknown"
	// EffectNeverHappened may only be used when the provider provably was not
	// reached. It keeps the job safely retryable.
	EffectNeverHappened EffectOutcome = "not-happened"
)

var (
	// ErrEffectUncertain means a previous attempt of this job left this effect
	// in an unknown state. Running it again could double-charge, so RhinoQ stops
	// and asks for an operator decision instead.
	ErrEffectUncertain = errors.New("effect is uncertain and requires an operator decision")
	// ErrEffectUnresolved means the effect is still open from another attempt.
	ErrEffectUnresolved = errors.New("effect is still pending from an earlier attempt")
	// ErrEffectLedgerMissing means the client has no effect store configured.
	ErrEffectLedgerMissing = errors.New("rhinoq effect ledger is not configured")
	// ErrEffectAlreadyConfirmed means the effect is already done and the call
	// must not run again.
	ErrEffectAlreadyConfirmed = errors.New("effect is already confirmed")
)

// EffectRequest declares one external side effect.
type EffectRequest struct {
	// Name identifies the effect inside the job, for example "charge-card".
	Name string `json:"name"`
	// Key makes the effect idempotent across attempts of the same job. Two
	// attempts using the same key run the provider call once.
	Key string `json:"key"`
	// Irreversible marks work that cannot be undone. RhinoQ never retries an
	// irreversible effect blindly.
	Irreversible bool `json:"irreversible"`
	// Confirm defaults to ConfirmOnReturn.
	Confirm ConfirmPolicy `json:"confirm,omitempty"`
	// CompletedStatus is the reference value ConfirmWhenStatus compares against.
	CompletedStatus string `json:"completedStatus,omitempty"`
}

func (r EffectRequest) normalize() (EffectRequest, error) {
	if r.Name == "" || r.Key == "" {
		return r, errors.New("effect name and idempotency key are required")
	}
	if r.Confirm == "" {
		r.Confirm = ConfirmOnReturn
	}
	switch r.Confirm {
	case ConfirmOnReturn, ConfirmExternalSignal, ConfirmVerify:
	case ConfirmWhenStatus:
		if r.CompletedStatus == "" {
			return r, errors.New("ConfirmWhenStatus requires a completed status to compare against")
		}
	default:
		return r, fmt.Errorf("unsupported confirmation policy: %s", r.Confirm)
	}
	return r, nil
}

// EffectResult is what the ledger holds after the call.
type EffectResult struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	State        string `json:"state"`
	ExternalRef  string `json:"externalRef,omitempty"`
	Irreversible bool   `json:"irreversible"`
}

// NotHappened wraps an error from an effect call that provably never reached
// the provider - a connection refused before the request was sent. It is the
// only way to tell RhinoQ that a retry is safe; everything else becomes
// uncertain, because an unknown result is not a failure.
func NotHappened(err error) error {
	if err == nil {
		return nil
	}
	return &notHappenedError{err: err}
}

type notHappenedError struct{ err error }

func (e *notHappenedError) Error() string { return e.err.Error() }
func (e *notHappenedError) Unwrap() error { return e.err }

// Effect runs an external side effect under the ledger. It is the default way
// to call a provider from a handler: the manual open/confirm API is too easy to
// use wrongly, and a forgotten confirm looks exactly like a lost effect.
//
//	result, err := job.Effect(ctx, rhinoq.EffectRequest{
//	    Name: "charge-card", Key: job.ID, Irreversible: true,
//	    Confirm: rhinoq.ConfirmOnReturn,
//	}, func(ctx context.Context) (string, error) {
//	    return payments.Charge(ctx, amount)
//	})
//
// The call is skipped entirely when a previous attempt already confirmed it,
// and refused when a previous attempt left it uncertain.
func (j Job) Effect(ctx context.Context, request EffectRequest, run func(context.Context) (string, error)) (EffectResult, error) {
	if run == nil {
		return EffectResult{}, errors.New("effect function is required")
	}
	opened, err := j.beginEffect(ctx, request)
	if err != nil {
		if errors.Is(err, ErrEffectAlreadyConfirmed) {
			return opened, nil
		}
		return opened, err
	}

	reference, runErr := run(ctx)
	if runErr != nil {
		outcome := EffectResultUnknown
		var never *notHappenedError
		if errors.As(runErr, &never) {
			outcome = EffectNeverHappened
		}
		resolved, err := j.resolveEffect(ctx, request, "", outcome)
		if err != nil {
			return resolved, errors.Join(runErr, err)
		}
		return resolved, runErr
	}
	return j.resolveEffect(ctx, request, reference, EffectSucceeded)
}

// beginEffect opens the ledger entry and decides whether the provider call may
// run at all. It returns ErrEffectAlreadyConfirmed when an earlier attempt
// already finished the work.
func (j Job) beginEffect(ctx context.Context, request EffectRequest) (EffectResult, error) {
	if j.client == nil || j.client.effects == nil {
		return EffectResult{}, ErrEffectLedgerMissing
	}
	request, err := request.normalize()
	if err != nil {
		return EffectResult{}, err
	}
	store := j.client.effects
	existing, found, err := store.GetEffect(ctx, j.ID, request.Name, request.Key)
	if err != nil {
		return EffectResult{}, err
	}
	if found {
		switch existing.State {
		case domaineffect.Confirmed:
			return effectResult(existing), fmt.Errorf("%w: %s/%s", ErrEffectAlreadyConfirmed, request.Name, request.Key)
		case domaineffect.Uncertain:
			return effectResult(existing), fmt.Errorf("%w: %s/%s", ErrEffectUncertain, request.Name, request.Key)
		case domaineffect.Pending:
			if existing.LeaseEpoch != j.lease.Epoch {
				return effectResult(existing), fmt.Errorf("%w: %s/%s", ErrEffectUnresolved, request.Name, request.Key)
			}
		}
	}
	id := existing.ID
	if id == "" {
		id = domaineffect.ID(fmt.Sprintf("effect_%s_%s_%s", j.ID, request.Name, request.Key))
	}
	record, err := j.service().Begin(ctx, j.lease, id, request.Name, request.Key, request.Irreversible)
	if err != nil {
		return EffectResult{}, err
	}
	return effectResult(record), nil
}

// resolveEffect records what happened to a provider call that has already run.
func (j Job) resolveEffect(ctx context.Context, request EffectRequest, reference string, outcome EffectOutcome) (EffectResult, error) {
	if j.client == nil || j.client.effects == nil {
		return EffectResult{}, ErrEffectLedgerMissing
	}
	request, err := request.normalize()
	if err != nil {
		return EffectResult{}, err
	}
	record, found, err := j.client.effects.GetEffect(ctx, j.ID, request.Name, request.Key)
	if err != nil {
		return EffectResult{}, err
	}
	if !found {
		return EffectResult{}, errors.New("effect was never opened")
	}
	switch outcome {
	case EffectNeverHappened:
		closed := record
		closed.State = domaineffect.NotHappened
		if err := j.client.effects.ConfirmEffect(ctx, j.lease, time.Now().UTC(), closed); err != nil {
			return effectResult(record), err
		}
		return effectResult(closed), nil
	case EffectResultUnknown:
		// The call may have happened. Recording that honestly is what stops the
		// next attempt from charging the card a second time.
		uncertain, err := j.service().MarkUncertain(ctx, record)
		if err != nil {
			return effectResult(record), err
		}
		return effectResult(uncertain), nil
	case EffectSucceeded:
		confirmed, err := j.service().Confirm(ctx, j.lease, record, domaineffect.ConfirmationPolicy{
			Kind:            domaineffect.ConfirmationKind(request.Confirm),
			CompletedStatus: request.CompletedStatus,
		}, reference)
		if err != nil {
			return effectResult(record), err
		}
		return effectResult(confirmed), nil
	default:
		return effectResult(record), fmt.Errorf("unsupported effect outcome: %s", outcome)
	}
}

// EffectState reads back what the ledger holds for one effect of this job.
func (j Job) EffectState(ctx context.Context, name, key string) (EffectResult, bool, error) {
	if j.client == nil || j.client.effects == nil {
		return EffectResult{}, false, ErrEffectLedgerMissing
	}
	record, found, err := j.client.effects.GetEffect(ctx, j.ID, name, key)
	if err != nil || !found {
		return EffectResult{}, found, err
	}
	return effectResult(record), true, nil
}

// ConfirmEffect records proof that arrived after the handler returned, such as
// a provider webhook for an effect declared with ConfirmExternalSignal.
func (c *Client) ConfirmEffect(ctx context.Context, jobID, name, key, reference string) (EffectResult, error) {
	if c == nil || c.effects == nil {
		return EffectResult{}, ErrEffectLedgerMissing
	}
	record, found, err := c.effects.GetEffect(ctx, jobID, name, key)
	if err != nil {
		return EffectResult{}, err
	}
	if !found {
		return EffectResult{}, errors.New("effect not found")
	}
	updated, err := record.Confirm(domaineffect.ConfirmationPolicy{Kind: domaineffect.OnReturn}, reference)
	if err != nil {
		return effectResult(record), err
	}
	// An external signal is authored by RhinoQ, not by a running execution:
	// there is no lease left to present by the time a webhook arrives.
	if err := c.effects.SaveEffect(ctx, updated); err != nil {
		return effectResult(record), err
	}
	return effectResult(updated), nil
}

func (j Job) service() *applicationeffect.Service {
	return applicationeffect.NewService(j.client.effects, func() time.Time { return time.Now().UTC() })
}

func effectResult(record domaineffect.Record) EffectResult {
	return EffectResult{
		ID: string(record.ID), Name: record.Name, State: string(record.State),
		ExternalRef: record.ExternalRef, Irreversible: record.Irreversible,
	}
}
