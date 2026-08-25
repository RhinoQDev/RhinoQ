# Owner Task API

The owner API is mounted at `/tasks` by `createRhinoQApp().http()`. The host
application authenticates the request and supplies stable owner and tenant
identity. RhinoQ never accepts those identities from an untrusted owner header
by default.

Read `GET /tasks/_capabilities` before rendering actions. A false capability
means the corresponding request is intentionally unavailable in this mount;
clients must not infer support from the Task state alone.

Security boundary: `PostgresTaskClient.getTaskExecution()` and
`transitionTaskExecution()` are runtime/adapter-only primitives and must not be
mounted as tenant routes. Owner-facing by-ID access uses
`getTaskExecutionForOwner(executionId, ownerId, tenantId)` and
`transitionTaskExecutionForOwner(...)`; both enforce the owner and tenant
predicate in the SQL command.

## Cancel a Task

```http
POST /tasks/{taskId}/cancel
Content-Type: application/json

{}
```

`expectedVersion` is optional. Supply the latest positive
`Task.entityVersion` only when the application wants a stale UI action to be
rejected:

```json
{ "expectedVersion": 7 }
```

Until the application supplies a cancellation composition, the portable
application advertises `cancel: false` and returns HTTP 409 without reading or
mutating Task state. A runtime capability alone is not sufficient because the
owner endpoint still needs to select the correct runtime references and handle
unknown external outcomes:

```json
{
  "code": "RHINOQ_UNSUPPORTED",
  "message": "Cancellation is not configured for this owner API; no Task state was changed.",
  "field": "action",
  "retryable": false,
  "nextAction": "Configure app.http({ cancelTask }) or open the runtime tool if it offers a safe cancellation workflow.",
  "docs": "https://github.com/RhinoQDev/RhinoQ/blob/main/docs/task-api.md#cancel-a-task"
}
```

Applications with their own safe cancellation composition may pass
`cancelTask` to `app.http()`. Ownership and tenant checks run before that hook.
The hook remains responsible for runtime semantics and must not report success
for an unknown external result.

An invalid fence returns HTTP 400 with `field`, `expectedShape`, `nextAction`
and `docs`. Consumers should display the message and follow `nextAction`; they
must not blindly retry a mutation.

## Retry a Task

Retry is disabled until the application supplies `app.http({ retryTask })`.
The application owns dispatch correctness and must use the mandatory
`commandId` as a durable idempotency identity. A request contains both axes:

```json
{ "expectedVersion": 7, "commandId": "task-123-retry-7" }
```

Missing configuration returns `RHINOQ_RETRY_NOT_CONFIGURED`; malformed input
returns `RHINOQ_INVALID_REQUEST` with the offending field and expected shape.
Neither response authorizes a blind redispatch.

## Resolve a result

`GET /tasks/{taskId}/result` never returns the stored private reference by
default. Configure `app.http({ resolveResult })` to turn the owner-authorized
record into a short-lived URL, proxy response or another browser-safe result.
Without that callback the API returns `RHINOQ_RESULT_NOT_CONFIGURED` and a next
action instead of leaking the reference.

## OpenAPI contract

The npm package exports its machine-readable OpenAPI 3.1 contract at
`@rhinoq/node/openapi.json`. The build validates its version, complete public
operation inventory, implementation route markers and capability fields before
copying it into `dist/openapi.json`. The contract and its build scripts are
included in `build-info.json` source provenance.
