package integration_test

import (
	"context"
	"errors"
	"testing"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

func TestProviderOperationConfirmsUnknownStripeLikeResultWithoutDoubleCall(t *testing.T) {
	client := rhinoq.NewInMemory()
	calls, reads := 0, 0
	request := rhinoq.ProviderOperationRequest{
		Provider: "stripe", Operation: "refund", IdempotencyKey: "refund_order_42",
		Confirmation: rhinoq.ProviderConfirmByReadback,
	}
	call := func(context.Context, string) (rhinoq.ProviderAcceptance, error) {
		calls++
		return rhinoq.ProviderAcceptance{}, errors.New("EOF after provider accepted request")
	}
	readback := func(context.Context, rhinoq.ProviderOperationRecord) (rhinoq.ProviderConfirmation, error) {
		reads++
		return rhinoq.ProviderConfirmation{Decision: rhinoq.ProviderConfirmed, Evidence: "re_42:succeeded"}, nil
	}

	first, err := client.ProviderOperation(context.Background(), request, call, readback)
	if err != nil {
		t.Fatalf("resolve unknown result: %v", err)
	}
	if first.State != "confirmed" || first.Evidence != "re_42:succeeded" || calls != 1 || reads != 1 {
		t.Fatalf("unexpected first result: %+v calls=%d reads=%d", first, calls, reads)
	}
	second, err := client.ProviderOperation(context.Background(), request, call, readback)
	if err != nil {
		t.Fatalf("repeat operation: %v", err)
	}
	if second.ID != first.ID || calls != 1 || reads != 1 {
		t.Fatalf("repeat invoked provider: first=%+v second=%+v calls=%d reads=%d", first, second, calls, reads)
	}
}

func TestProviderOperationKeepsUnknownClosedWhenReadbackAlsoFails(t *testing.T) {
	client := rhinoq.NewInMemory()
	request := rhinoq.ProviderOperationRequest{Provider: "stripe", Operation: "charge", IdempotencyKey: "charge_9"}
	record, err := client.ProviderOperation(context.Background(), request,
		func(context.Context, string) (rhinoq.ProviderAcceptance, error) {
			return rhinoq.ProviderAcceptance{}, errors.New("timeout")
		},
		func(context.Context, rhinoq.ProviderOperationRecord) (rhinoq.ProviderConfirmation, error) {
			return rhinoq.ProviderConfirmation{}, errors.New("stripe unavailable")
		})
	if err == nil || record.State != "uncertain" {
		t.Fatalf("expected uncertain and error, got %+v err=%v", record, err)
	}
	calls := 0
	record, err = client.ProviderOperation(context.Background(), request,
		func(context.Context, string) (rhinoq.ProviderAcceptance, error) {
			calls++
			return rhinoq.ProviderAcceptance{}, nil
		}, nil)
	if err != nil || record.State != "uncertain" || calls != 0 {
		t.Fatalf("uncertain retry was not fenced: %+v calls=%d err=%v", record, calls, err)
	}
}

func TestProviderOperationAcceptsLaterWebhookProof(t *testing.T) {
	client := rhinoq.NewInMemory()
	accepted, err := client.ProviderOperation(context.Background(), rhinoq.ProviderOperationRequest{
		Provider: "stripe", Operation: "payment_intent", IdempotencyKey: "pi-order-1",
		Confirmation: rhinoq.ProviderConfirmByWebhook,
	}, func(context.Context, string) (rhinoq.ProviderAcceptance, error) {
		return rhinoq.ProviderAcceptance{ProviderID: "pi_1"}, nil
	}, nil)
	if err != nil || accepted.State != "accepted" {
		t.Fatalf("accepted=%+v err=%v", accepted, err)
	}
	confirmed, err := client.ConfirmProviderOperation(context.Background(), accepted.ID, "evt_1:succeeded")
	if err != nil || confirmed.State != "confirmed" {
		t.Fatalf("confirmed=%+v err=%v", confirmed, err)
	}
	repeat, err := client.ConfirmProviderOperation(context.Background(), accepted.ID, "evt_1:succeeded")
	if err != nil || repeat.Version != confirmed.Version {
		t.Fatalf("repeat=%+v err=%v", repeat, err)
	}
}

func TestProviderOperationLinksUnknownResultToTaskAndKeepsEvidenceHistory(t *testing.T) {
	client := rhinoq.NewInMemory()
	ctx := context.Background()
	task, err := client.CreateTask(ctx, rhinoq.TaskCreateRequest{ID: "refund-task-uncertain", Type: "stripe.refund", DefinitionVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	task, err = client.QueueTask(ctx, task.ID, task.EntityVersion)
	if err != nil {
		t.Fatal(err)
	}
	task, err = client.StartTask(ctx, task.ID, task.EntityVersion)
	if err != nil {
		t.Fatal(err)
	}
	record, err := client.ProviderOperation(ctx, rhinoq.ProviderOperationRequest{
		TaskID: task.ID, Provider: "stripe", Operation: "refund", IdempotencyKey: "refund-task-key",
		Confirmation: rhinoq.ProviderConfirmByReadback,
	}, func(context.Context, string) (rhinoq.ProviderAcceptance, error) {
		return rhinoq.ProviderAcceptance{}, errors.New("response timeout after request upload")
	}, func(context.Context, rhinoq.ProviderOperationRecord) (rhinoq.ProviderConfirmation, error) {
		return rhinoq.ProviderConfirmation{Decision: rhinoq.ProviderStillPending, Evidence: "provider lookup pending"}, nil
	})
	if err == nil || record.State != "uncertain" {
		t.Fatalf("record=%+v err=%v", record, err)
	}
	task, err = client.GetTask(ctx, task.ID)
	if err != nil || task.State != rhinoq.TaskUncertain {
		t.Fatalf("task=%+v err=%v", task, err)
	}
	evidence, err := client.ListProviderOperationEvidence(ctx, record.ID)
	if err != nil || len(evidence) != 1 || evidence[0].Kind != "resolution" || evidence[0].Payload == "" {
		t.Fatalf("evidence=%+v err=%v", evidence, err)
	}
	confirmed, err := client.RecheckProviderOperation(ctx, record.ID, func(context.Context, rhinoq.ProviderOperationRecord) (rhinoq.ProviderConfirmation, error) {
		return rhinoq.ProviderConfirmation{Decision: rhinoq.ProviderConfirmed, Evidence: "re_42:succeeded"}, nil
	})
	if err != nil || confirmed.State != "confirmed" {
		t.Fatalf("confirmed=%+v err=%v", confirmed, err)
	}
	evidence, err = client.ListProviderOperationEvidence(ctx, record.ID)
	if err != nil || len(evidence) != 2 || evidence[1].Sequence <= evidence[0].Sequence || evidence[1].Kind != "confirmed" {
		t.Fatalf("evidence=%+v err=%v", evidence, err)
	}
}
