package rhinoq

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	providerapp "github.com/madebyduy/RhinoQ/internal/application/provideroperations"
	"github.com/madebyduy/RhinoQ/internal/domain/provideroperation"
)

type ProviderConfirmationPolicy string

const (
	ProviderConfirmOnReturn   ProviderConfirmationPolicy = "on-return"
	ProviderConfirmByReadback ProviderConfirmationPolicy = "readback"
	ProviderConfirmByWebhook  ProviderConfirmationPolicy = "webhook"
)

type ProviderOperationRequest struct {
	TaskID             string                     `json:"taskId,omitempty"`
	Provider           string                     `json:"provider"`
	Operation          string                     `json:"operation"`
	IdempotencyKey     string                     `json:"idempotencyKey"`
	RequestFingerprint string                     `json:"requestFingerprint,omitempty"`
	Confirmation       ProviderConfirmationPolicy `json:"confirmation"`
	RetryPolicy        ProviderRetryPolicy        `json:"retryPolicy"`
}

type ProviderRetryPolicy string

const (
	ProviderRetryNever           ProviderRetryPolicy = "never"
	ProviderRetryWhenNotHappened ProviderRetryPolicy = "when-not-happened"
)

type ProviderAcceptance struct {
	ProviderID string `json:"providerId"`
	Evidence   string `json:"evidence,omitempty"`
}

type ProviderConfirmationDecision string

const (
	ProviderConfirmed    ProviderConfirmationDecision = "confirmed"
	ProviderStillPending ProviderConfirmationDecision = "pending"
	ProviderRejected     ProviderConfirmationDecision = "rejected"
	ProviderFailed       ProviderConfirmationDecision = "failed"
	ProviderDidNotHappen ProviderConfirmationDecision = "not_happened"
	ProviderUnknown      ProviderConfirmationDecision = "unknown"
)

type ProviderConfirmation struct {
	Decision ProviderConfirmationDecision `json:"decision"`
	Evidence string                       `json:"evidence,omitempty"`
	Reason   string                       `json:"reason,omitempty"`
}

type ProviderOperationRecord struct {
	ID                 string                     `json:"id"`
	TaskID             string                     `json:"taskId,omitempty"`
	Provider           string                     `json:"provider"`
	Operation          string                     `json:"operation"`
	IdempotencyKey     string                     `json:"idempotencyKey"`
	RequestFingerprint string                     `json:"requestFingerprint,omitempty"`
	Confirmation       ProviderConfirmationPolicy `json:"confirmation"`
	RetryPolicy        ProviderRetryPolicy        `json:"retryPolicy"`
	State              string                     `json:"state"`
	ProviderID         string                     `json:"providerId,omitempty"`
	Evidence           string                     `json:"evidence,omitempty"`
	Reason             string                     `json:"reason,omitempty"`
	Version            int64                      `json:"version"`
	CreatedAt          time.Time                  `json:"createdAt"`
	UpdatedAt          time.Time                  `json:"updatedAt"`
}

type ProviderOperationEvidence struct {
	Sequence  int64     `json:"sequence"`
	Kind      string    `json:"kind"`
	Payload   string    `json:"payload"`
	CreatedAt time.Time `json:"createdAt"`
}

type ProviderCall func(context.Context, string) (ProviderAcceptance, error)
type ProviderReadback func(context.Context, ProviderOperationRecord) (ProviderConfirmation, error)

// BeginProviderOperation reserves the provider/idempotency identity without
// executing external code. Remote SDKs use this authoritative command before
// they invoke a provider in their own process.
func (c *IntegrityClient) BeginProviderOperation(ctx context.Context, request ProviderOperationRequest) (ProviderOperationRecord, error) {
	if c == nil || c.providerOperations == nil {
		return ProviderOperationRecord{}, errors.New("rhinoq provider operation store is not configured")
	}
	if request.Confirmation == "" {
		request.Confirmation = ProviderConfirmByReadback
	}
	if request.RetryPolicy == "" {
		request.RetryPolicy = ProviderRetryWhenNotHappened
	}
	if request.Confirmation != ProviderConfirmOnReturn && request.Confirmation != ProviderConfirmByReadback && request.Confirmation != ProviderConfirmByWebhook {
		return ProviderOperationRecord{}, errors.New("unsupported provider confirmation policy")
	}
	if request.RetryPolicy != ProviderRetryNever && request.RetryPolicy != ProviderRetryWhenNotHappened {
		return ProviderOperationRecord{}, errors.New("unsupported provider retry policy")
	}
	id, err := newProviderOperationID()
	if err != nil {
		return ProviderOperationRecord{}, err
	}
	service, _ := providerapp.New(c.providerOperations, nil)
	record, err := service.BeginWithFingerprint(ctx, provideroperation.ID(id), request.TaskID,
		request.Provider, request.Operation, request.IdempotencyKey,
		request.RequestFingerprint,
		provideroperation.ConfirmationPolicy(request.Confirmation), provideroperation.RetryPolicy(request.RetryPolicy))
	return publicProviderOperation(record), err
}

func (c *IntegrityClient) AcceptProviderOperation(ctx context.Context, id, providerID, evidence string) (ProviderOperationRecord, error) {
	service, record, err := c.providerOperationForMutation(ctx, id)
	if err != nil {
		return ProviderOperationRecord{}, err
	}
	record, err = service.Accept(ctx, record, providerID, evidence)
	return publicProviderOperation(record), err
}

func (c *IntegrityClient) ResolveProviderOperation(ctx context.Context, id string, decision ProviderConfirmation) (ProviderOperationRecord, error) {
	service, record, err := c.providerOperationForMutation(ctx, id)
	if err != nil {
		return ProviderOperationRecord{}, err
	}
	switch decision.Decision {
	case ProviderConfirmed:
		record, err = service.Confirm(ctx, record, decision.Evidence)
	case ProviderFailed, ProviderRejected:
		record, err = service.Resolve(ctx, record, provideroperation.Failed, decision.Reason)
	case ProviderDidNotHappen:
		record, err = service.Resolve(ctx, record, provideroperation.NotHappened, decision.Reason)
	case ProviderUnknown:
		record, err = service.Resolve(ctx, record, provideroperation.Uncertain, decision.Reason)
	default:
		return publicProviderOperation(record), errors.New("unsupported provider resolution")
	}
	if record.State == provideroperation.Uncertain {
		err = errors.Join(err, c.markUncertainTask(ctx, record))
	}
	return publicProviderOperation(record), err
}

func (c *IntegrityClient) RetryProviderOperation(ctx context.Context, id string) (ProviderOperationRecord, error) {
	service, record, err := c.providerOperationForMutation(ctx, id)
	if err != nil {
		return ProviderOperationRecord{}, err
	}
	record, err = service.Retry(ctx, record)
	return publicProviderOperation(record), err
}

func (c *IntegrityClient) providerOperationForMutation(ctx context.Context, id string) (*providerapp.Service, provideroperation.Record, error) {
	if c == nil || c.providerOperations == nil {
		return nil, provideroperation.Record{}, errors.New("rhinoq provider operation store is not configured")
	}
	service, _ := providerapp.New(c.providerOperations, nil)
	record, err := service.Get(ctx, provideroperation.ID(id))
	return service, record, err
}

// ProviderOperation executes an idempotent provider call once and records a
// truthful outcome. Any unclassified call error becomes uncertain; a retry
// never invokes call again until readback proves the first request did not
// happen.
func (c *IntegrityClient) ProviderOperation(ctx context.Context, request ProviderOperationRequest, call ProviderCall, readback ProviderReadback) (ProviderOperationRecord, error) {
	if c == nil || c.providerOperations == nil {
		return ProviderOperationRecord{}, errors.New("rhinoq provider operation store is not configured")
	}
	if call == nil {
		return ProviderOperationRecord{}, errors.New("provider call is required")
	}
	if request.Confirmation == "" {
		request.Confirmation = ProviderConfirmByReadback
	}
	if request.RetryPolicy == "" {
		request.RetryPolicy = ProviderRetryWhenNotHappened
	}
	if request.RetryPolicy != ProviderRetryNever && request.RetryPolicy != ProviderRetryWhenNotHappened {
		return ProviderOperationRecord{}, errors.New("unsupported provider retry policy")
	}
	if request.Confirmation != ProviderConfirmOnReturn && request.Confirmation != ProviderConfirmByReadback && request.Confirmation != ProviderConfirmByWebhook {
		return ProviderOperationRecord{}, errors.New("unsupported provider confirmation policy")
	}
	recordPublic, err := c.BeginProviderOperation(ctx, request)
	if err != nil {
		return ProviderOperationRecord{}, err
	}
	service, _ := providerapp.New(c.providerOperations, nil)
	record, err := service.Get(ctx, provideroperation.ID(recordPublic.ID))
	if err != nil {
		return ProviderOperationRecord{}, err
	}

	if record.State == provideroperation.Confirmed {
		return publicProviderOperation(record), nil
	}
	if record.State == provideroperation.NotHappened {
		record, err = service.Retry(ctx, record)
		if err != nil {
			return publicProviderOperation(record), err
		}
	}
	if record.State == provideroperation.Accepted || record.State == provideroperation.Uncertain {
		return c.readbackProviderOperation(ctx, service, record, readback)
	}
	if record.State != provideroperation.Pending {
		return publicProviderOperation(record), fmt.Errorf("provider operation is %s", record.State)
	}

	accepted, callErr := call(ctx, request.IdempotencyKey)
	if callErr != nil {
		var never *notHappenedError
		if errors.As(callErr, &never) {
			record, err = service.Resolve(ctx, record, provideroperation.NotHappened, callErr.Error())
			return publicProviderOperation(record), errors.Join(callErr, err)
		}
		record, err = service.Resolve(ctx, record, provideroperation.Uncertain, callErr.Error())
		if err != nil {
			return publicProviderOperation(record), errors.Join(callErr, err)
		}
		resolved, verifyErr := c.readbackProviderOperation(ctx, service, record, readback)
		if verifyErr == nil && resolved.State == string(provideroperation.Confirmed) {
			return resolved, nil
		}
		return resolved, errors.Join(callErr, verifyErr)
	}
	record, err = service.Accept(ctx, record, accepted.ProviderID, accepted.Evidence)
	if err != nil {
		return publicProviderOperation(record), err
	}
	if request.Confirmation == ProviderConfirmOnReturn {
		evidence := accepted.Evidence
		if evidence == "" {
			evidence = accepted.ProviderID
		}
		record, err = service.Confirm(ctx, record, evidence)
		return publicProviderOperation(record), err
	}
	if request.Confirmation == ProviderConfirmByWebhook {
		return publicProviderOperation(record), nil
	}
	return c.readbackProviderOperation(ctx, service, record, readback)
}

// RecheckProviderOperation performs one bounded polling confirmation without
// ever invoking the provider mutation callback again.
func (c *IntegrityClient) RecheckProviderOperation(ctx context.Context, id string, readback ProviderReadback) (ProviderOperationRecord, error) {
	if c == nil || c.providerOperations == nil {
		return ProviderOperationRecord{}, errors.New("rhinoq provider operation store is not configured")
	}
	service, _ := providerapp.New(c.providerOperations, nil)
	record, err := service.Get(ctx, provideroperation.ID(id))
	if err != nil {
		return ProviderOperationRecord{}, err
	}
	return c.readbackProviderOperation(ctx, service, record, readback)
}

func (c *IntegrityClient) ListProviderOperationEvidence(ctx context.Context, id string) ([]ProviderOperationEvidence, error) {
	if c == nil || c.providerOperations == nil {
		return nil, errors.New("rhinoq provider operation store is not configured")
	}
	service, _ := providerapp.New(c.providerOperations, nil)
	items, err := service.Evidence(ctx, provideroperation.ID(id))
	if err != nil {
		return nil, err
	}
	result := make([]ProviderOperationEvidence, len(items))
	for i, item := range items {
		result[i] = ProviderOperationEvidence{Sequence: item.Sequence, Kind: item.Kind, Payload: item.Payload, CreatedAt: item.CreatedAt}
	}
	return result, nil
}

func (c *IntegrityClient) GetProviderOperation(ctx context.Context, id string) (ProviderOperationRecord, error) {
	if c == nil || c.providerOperations == nil {
		return ProviderOperationRecord{}, errors.New("rhinoq provider operation store is not configured")
	}
	service, _ := providerapp.New(c.providerOperations, nil)
	record, err := service.Get(ctx, provideroperation.ID(id))
	return publicProviderOperation(record), err
}

// ConfirmProviderOperation records proof delivered later by a provider
// webhook. Repeating the same confirmation is idempotent.
func (c *IntegrityClient) ConfirmProviderOperation(ctx context.Context, id, evidence string) (ProviderOperationRecord, error) {
	if c == nil || c.providerOperations == nil {
		return ProviderOperationRecord{}, errors.New("rhinoq provider operation store is not configured")
	}
	service, _ := providerapp.New(c.providerOperations, nil)
	record, err := service.Get(ctx, provideroperation.ID(id))
	if err != nil {
		return ProviderOperationRecord{}, err
	}
	record, err = service.Confirm(ctx, record, evidence)
	return publicProviderOperation(record), err
}

func (c *IntegrityClient) readbackProviderOperation(ctx context.Context, service *providerapp.Service, record provideroperation.Record, readback ProviderReadback) (ProviderOperationRecord, error) {
	if readback == nil {
		return publicProviderOperation(record), c.markUncertainTask(ctx, record)
	}
	confirmation, err := readback(ctx, publicProviderOperation(record))
	if err != nil {
		return publicProviderOperation(record), errors.Join(err, c.markUncertainTask(ctx, record))
	}
	switch confirmation.Decision {
	case ProviderConfirmed:
		record, err = service.Confirm(ctx, record, confirmation.Evidence)
	case ProviderDidNotHappen:
		record, err = service.Resolve(ctx, record, provideroperation.NotHappened, confirmation.Reason)
	case ProviderRejected, ProviderFailed:
		record, err = service.Resolve(ctx, record, provideroperation.Failed, confirmation.Reason)
	case ProviderStillPending:
		// Accepted is a provider fact; uncertain remains uncertain until proof arrives.
	case ProviderUnknown:
		if record.State != provideroperation.Uncertain {
			record, err = service.Resolve(ctx, record, provideroperation.Uncertain, confirmation.Reason)
		}
	default:
		err = errors.New("unsupported provider confirmation decision")
	}
	if record.State == provideroperation.Uncertain {
		err = errors.Join(err, c.markUncertainTask(ctx, record))
	}
	return publicProviderOperation(record), err
}

func (c *IntegrityClient) markUncertainTask(ctx context.Context, record provideroperation.Record) error {
	if record.State != provideroperation.Uncertain || record.TaskID == "" || c.markTaskUncertain == nil {
		return nil
	}
	return c.markTaskUncertain(ctx, record.TaskID)
}

func newProviderOperationID() (string, error) {
	var body [16]byte
	if _, err := rand.Read(body[:]); err != nil {
		return "", err
	}
	return "provider_op_" + hex.EncodeToString(body[:]), nil
}

func publicProviderOperation(record provideroperation.Record) ProviderOperationRecord {
	return ProviderOperationRecord{ID: string(record.ID), TaskID: record.TaskID, Provider: record.Provider,
		Operation: record.Operation, IdempotencyKey: record.IdempotencyKey,
		RequestFingerprint: record.RequestFingerprint,
		Confirmation:       ProviderConfirmationPolicy(record.Confirmation), RetryPolicy: ProviderRetryPolicy(record.RetryPolicy),
		State: string(record.State), ProviderID: record.ProviderID, Evidence: record.Evidence,
		Reason: record.Reason, Version: record.Version, CreatedAt: record.CreatedAt, UpdatedAt: record.UpdatedAt}
}
