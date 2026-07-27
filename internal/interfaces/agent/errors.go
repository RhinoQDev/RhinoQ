package agent

import (
	"errors"
	"net/http"

	"github.com/rhinoq/rhinoq/internal/contracts/diagnostic"
	"github.com/rhinoq/rhinoq/internal/domain/admission"
	"github.com/rhinoq/rhinoq/internal/domain/recovery"
	"github.com/rhinoq/rhinoq/internal/ports"
	"github.com/rhinoq/rhinoq/pkg/rhinoq"
)

// ErrorBody is the single error shape every endpoint returns. An SDK maps it
// into its own exception type; it never has to parse prose.
type ErrorBody struct {
	Code string `json:"code"`
	// Message is the operator-facing text, which for RhinoQ's own errors carries
	// all five parts: what happened, why it matters, what RhinoQ did, the fix,
	// and how to verify it.
	Message string `json:"message"`
	// Retryable tells the caller whether repeating the same request could work.
	Retryable bool `json:"retryable"`
	// RetryAfterMs is set when the Agent knows when to come back.
	RetryAfterMs int64 `json:"retryAfterMs,omitempty"`
}

type errorResponse struct {
	Error ErrorBody `json:"error"`
}

// describe maps an engine error onto an HTTP status and the wire envelope.
// Status codes carry meaning here: 409 means somebody else owns the job, 429
// means come back later, 422 means the request was understood and refused.
func describe(err error) (int, ErrorBody) {
	var overCapacity *admission.OverCapacityError
	if errors.As(err, &overCapacity) {
		return http.StatusTooManyRequests, ErrorBody{
			Code: "RHINOQ_QUEUE_OVER_CAPACITY", Message: err.Error(),
			Retryable: true, RetryAfterMs: overCapacity.RetryAfter.Milliseconds(),
		}
	}
	var leaseLost *ports.LeaseLostError
	if errors.As(err, &leaseLost) {
		return http.StatusConflict, ErrorBody{
			Code: "RHINOQ_LEASE_LOST", Message: err.Error(), Retryable: false,
		}
	}
	if errors.Is(err, ports.ErrLeaseLost) {
		return http.StatusConflict, ErrorBody{
			Code: "RHINOQ_LEASE_LOST", Message: err.Error(), Retryable: false,
		}
	}
	if errors.Is(err, ports.ErrJobNotFound) {
		return http.StatusNotFound, ErrorBody{Code: "RHINOQ_JOB_NOT_FOUND", Message: err.Error()}
	}
	switch {
	case errors.Is(err, rhinoq.ErrEffectUncertain):
		return http.StatusConflict, ErrorBody{Code: "RHINOQ_EFFECT_UNCERTAIN", Message: err.Error()}
	case errors.Is(err, rhinoq.ErrEffectUnresolved):
		return http.StatusConflict, ErrorBody{Code: "RHINOQ_EFFECT_UNRESOLVED", Message: err.Error()}
	case errors.Is(err, rhinoq.ErrEffectAlreadyConfirmed):
		return http.StatusConflict, ErrorBody{Code: "RHINOQ_EFFECT_ALREADY_CONFIRMED", Message: err.Error()}
	case errors.Is(err, rhinoq.ErrEffectLedgerMissing):
		return http.StatusServiceUnavailable, ErrorBody{Code: "RHINOQ_EFFECT_LEDGER_MISSING", Message: err.Error()}
	case errors.Is(err, recovery.ErrReplayState),
		errors.Is(err, recovery.ErrConfirmedEffect),
		errors.Is(err, recovery.ErrUncertainEffect),
		errors.Is(err, recovery.ErrUnresolvedEffect):
		return http.StatusUnprocessableEntity, ErrorBody{Code: "RHINOQ_REPLAY_REFUSED", Message: err.Error()}
	case errors.Is(err, recovery.ErrInvalidReplayRequest):
		return http.StatusBadRequest, ErrorBody{Code: "RHINOQ_INVALID_REQUEST", Message: err.Error()}
	}
	return http.StatusBadRequest, ErrorBody{Code: "RHINOQ_INVALID_REQUEST", Message: err.Error()}
}

func unauthorized() (int, ErrorBody) {
	message := diagnostic.Message{
		Code:          "RHINOQ_UNAUTHORIZED",
		WhatHappened:  "The request did not carry a valid Agent token.",
		WhyItMatters:  "The Agent can enqueue, cancel and replay work. An open Agent is an\nopen door to every queue behind it.",
		WhatRhinoQDid: "The request was refused. Nothing was read and nothing was written.",
		HowToFix:      "Send the token as a header:\n  Authorization: Bearer <RHINOQ_AGENT_TOKEN>",
		Verify:        "curl -H \"Authorization: Bearer $RHINOQ_AGENT_TOKEN\" <agent>/health/ready",
	}
	return http.StatusUnauthorized, ErrorBody{Code: message.Code, Message: message.Error()}
}
