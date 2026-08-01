# RhinoQ Stripe response-loss demo

This is the product demo: Next.js, BullMQ, PostgreSQL, a Stripe-shaped sandbox
and the real RhinoQ Go Gateway. It proves that a BullMQ `completed` result does
not have to become a false business success.

## Run

From this directory:

```bash
docker compose up --build -d
docker compose run --rm app npm run test:e2e
```

The migration container retries a bounded number of times because the official
PostgreSQL image can briefly accept connections during its temporary init
server and then restart the final server. A persistent migration or schema
error still stops the stack.

Open <http://localhost:53000> to run the six steps manually. Clean up with:

```bash
docker compose down -v
```

## Expected flow

1. `Break it` creates an order, Task, BullMQ Execution and refund job.
2. The Stripe-shaped endpoint commits a refund and delays its response. The
   worker times out after 100 ms, then BullMQ still records the handler as
   completed.
3. RhinoQ stores the operation and Task as `uncertain`; one Rule observation
   opens a Finding because `demo_orders.refunded_at` is still null.
4. `Recheck Stripe` retrieves the refund without issuing a second mutation.
5. `Propose` and `Dry-run` store a stable order-version precondition.
6. A different actor approves. `Repair + verify` invokes the allowlisted,
   HMAC-signed application callback with the repair ID as idempotency key and
   resolves the Finding only after read-back passes.

`demo_stripe_refunds` is intentionally local so CI never needs a secret. The
provider boundary matches Stripe's idempotency/read-back behavior; production
code supplies the official Stripe SDK through `stripeProviderAdapter`.

The Gateway refuses unregistered repair handlers. The callback URL and secret
come from deployment configuration, not the browser, and arbitrary SQL is not
part of the repair protocol.
