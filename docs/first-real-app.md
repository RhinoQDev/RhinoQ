# First real application: report export

[`examples/report-export`](../examples/report-export/) is the acceptance
example. It uses stable server-side authentication, two owners in one tenant,
a manual runtime, an authorized result endpoint and independent storage
readback.

Run `npm test` in that directory. The suite proves a normal `1/1` result, owner
isolation, a completed runtime with missing output becoming `uncertain`, and a
guarded repair with preview, separate approval, idempotency and post-check.

The storage implementation is a test double. Replace it with an application
adapter and preserve the same `verified`/`mismatch`/`unknown` semantics.
