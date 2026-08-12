# Production checklist

- Authenticate before resolving owner and tenant; test two owners and tenants.
- Use stable runtime scope, application keys and replica identity.
- Keep provider/storage credentials server-side.
- Configure result access separately from durable result recording.
- Configure verifier outcomes for present/mismatch/unknown and timeouts.
- Require preview, separate approval, idempotency and post-check for repair.
- Run the runtime parity suite for every enabled adapter.
- Run PostgreSQL interruption, lost-response, duplicate/out-of-order event and
  multi-replica campaigns against disposable services.
- Scan rendered owner HTML and JSON for secrets and private references.
- Do not treat Failure Lab's simulated repair as provider evidence.
