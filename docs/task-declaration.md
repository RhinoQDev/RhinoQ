# Declare a Task once

For one Task or a gradual migration, create the RhinoQ application normally,
then declare each business handler once:

```ts
const exportReport = app.task({
  name: 'report.export',
  adapter: 'bullmq',
  runtime: 'bullmq',
  scope: 'reports',
  retry: { mode: 'runtime', maxAttempts: 3,
    backoff: { type: 'exponential', delayMs: 1000 } },
  run: async ({ reportId }, { progress }) => {
    await progress(0, 1, 'Generating report');
    return generateReport(reportId);
  },
  result: ({ url }) => ({ ref: url, mediaType: 'application/pdf' }),
});
```

Use `exportReport.dispatch(...)` in the producer and
`exportReport.workerHandler()` with the selected runtime's registered worker.
The handler rejects an envelope for another Task name/version, so a worker does
not execute an unregistered job name.

The declaration centralizes registration identity, dispatch, progress and
result metadata. The selected RhinoQ adapter and authoritative runtime still
own reservation, lifecycle events, retry execution, lease fencing,
reconciliation and durable state.

## Safety defaults

- Automatic retry defaults to `{ mode: 'never' }`.
- Runtime retry requires a positive, bounded `maxAttempts`.
- Backoff requires an explicit positive `delayMs`; RhinoQ does not guess it.
- `externalEffect: true` is refused unless `effect.idempotency` and
  `effect.confirmation` are declared.
- The application must provide stable Task/owner identity and choose the
  correct adapter, runtime and scope.

RhinoQ deliberately does not infer whether charging, emailing, refunding or
publishing is safe to repeat. Unknown external outcomes remain subject to the
existing fail-closed/uncertain contracts.

For a new integration, prefer the typed registry in the
[Task application compiler](./application-compiler.md). It removes repeated
adapter/runtime/scope fields and collects declarations into one manifest; this
lower-level API remains available and compatible.
