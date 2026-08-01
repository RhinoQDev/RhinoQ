package ports

import (
	"errors"
	"fmt"

	"github.com/madebyduy/RhinoQ/internal/contracts/diagnostic"
)

var (
	// ErrLeaseLost matches every fencing rejection through errors.Is. A store
	// returns it when the presented owner and epoch are no longer the ones the
	// database recognises, which means another execution owns the job now.
	ErrLeaseLost                    = errors.New("RHINOQ_LEASE_LOST")
	ErrJobNotFound                  = errors.New("RHINOQ_JOB_NOT_FOUND")
	ErrFindingNotFound              = errors.New("RHINOQ_FINDING_NOT_FOUND")
	ErrRuleNotFound                 = errors.New("RHINOQ_RULE_NOT_FOUND")
	ErrTaskNotFound                 = errors.New("RHINOQ_TASK_NOT_FOUND")
	ErrTaskResultNotFound           = errors.New("RHINOQ_TASK_RESULT_NOT_FOUND")
	ErrExecutionNotFound            = errors.New("RHINOQ_EXECUTION_NOT_FOUND")
	ErrProviderOperationNotFound    = errors.New("RHINOQ_PROVIDER_OPERATION_NOT_FOUND")
	ErrNotificationDeliveryNotFound = errors.New("RHINOQ_NOTIFICATION_DELIVERY_NOT_FOUND")
	ErrRepairNotFound               = errors.New("RHINOQ_REPAIR_NOT_FOUND")
	ErrVersionConflict              = errors.New("RHINOQ_VERSION_CONFLICT")
	ErrAlreadyExists                = errors.New("RHINOQ_ALREADY_EXISTS")
)

// LeaseLostError explains a fencing rejection to the operator reading the log.
type LeaseLostError struct {
	Lease  Lease
	Detail string
}

func LeaseLost(lease Lease, detail string) error {
	return &LeaseLostError{Lease: lease, Detail: detail}
}

func (e *LeaseLostError) Error() string { return e.Message().Error() }

func (e *LeaseLostError) Unwrap() error { return ErrLeaseLost }

func (e *LeaseLostError) Message() diagnostic.Message {
	detail := e.Detail
	if detail == "" {
		detail = "the stored owner or epoch no longer matches"
	}
	return diagnostic.Message{
		Code: "RHINOQ_LEASE_LOST",
		WhatHappened: fmt.Sprintf("job: %s · owner: %s · epoch: %d\n%s",
			e.Lease.JobID, e.Lease.Owner, e.Lease.Epoch, detail),
		WhyItMatters: "Another worker may already be running this job. Writing state from\n" +
			"this execution would overwrite the live one, and any external effect\n" +
			"started from here would run a second time.",
		WhatRhinoQDid: "The write was refused and nothing changed. This execution must stop;\n" +
			"the job stays with whichever execution holds the current epoch.",
		HowToFix: "Stop the handler as soon as a lease operation fails. If this repeats,\n" +
			"the lease is shorter than the real runtime: raise the lease duration or\n" +
			"lower the heartbeat interval so renewals land before expiry.",
		Verify: fmt.Sprintf("rhinoq job inspect %s", e.Lease.JobID),
	}
}
