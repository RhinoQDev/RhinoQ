# ProviderOperation

`ProviderOperation` is the safe boundary for calls such as Stripe refunds,
provisioning, fulfilment and email sends. It persists one operation under
`(provider, operation, idempotencyKey)` before the call runs.

The authoritative states are:

```text
pending -> accepted -> confirmed
   |          |
   +----------+-> uncertain
   +------------> not_happened | failed
```

A timeout is `uncertain`, not `failed`. Repeating the same operation reads the
stored record and does not call the provider again until read-back proves that
the request did not happen. Confirmation is explicit: synchronous return,
provider read-back, or a later webhook.

For webhook confirmation, persist the accepted record's ID and call
`ConfirmProviderOperation(ctx, id, evidence)` from the authenticated webhook
handler. Repeating the same proof is idempotent.

The executable Go failure probe needs no credentials:

```bash
go run ./examples/stripe-failure
```

It commits a fake refund, drops the response connection, confirms by read-back,
then repeats the operation. The output must show `provider_calls=1` both times.

Migrations 018 and 021 add the operation contract and append-only evidence.
Go owns the state machine. Node reserves and transitions operations through the
Gateway before it invokes application-owned provider code:

```ts
const operation = await rhinoq.providerOperation({
  taskId,
  name: 'stripe.refund',
  idempotencyKey,
  execute: (key) => stripe.refunds.create(params, { idempotencyKey: key }),
  confirm: (record) => retrieveRefund(record),
});
```

Reference adapters exist for Stripe and provisioning/storage. They adapt SDK
results only; they do not contain retry or state-machine correctness. The full
Next.js/BullMQ/PostgreSQL demo is in `examples/nextjs-bullmq-stripe`.
