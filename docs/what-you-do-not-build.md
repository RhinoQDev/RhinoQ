# What you do not build

With the full Task surface, the application does not implement Task tables,
owner-scoped list/detail routes, SSE parsing, polling fallback, reconnect
backoff, stale-version rejection, attempt pagination, Task Center, or the first
operator incident view.

It also does not have to assemble queue storage when choosing the native
PostgreSQL runtime, lease/heartbeat/retry fencing, aggregate fan-out progress,
exactly-once settlement notification, projector leadership, missed-event
reconciliation, health/readiness/metrics wiring, notification deduplication or
the guarded repair state machine.

The CLI removes most first-run configuration work: it detects supported
dependencies and framework/queue declarations, previews every generated file,
refuses to overwrite existing code, applies or verifies the Task schema and
reports missing product-surface callbacks through `doctor`.

The application still owns authentication, tenant authorization, stable
business identity, worker logic, provider credentials, business verification
and repair implementations. RhinoQ provides guarded workflow around those
callbacks; it does not infer business success from runtime completion.

Use `createRhinoQApp()` for the complete product surface. Use lower-level
clients only when retaining the application's own API and UI is intentional.
