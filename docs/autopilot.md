# Bounded Autopilot

The Node SDK exposes a deterministic observe/recommend contract for operational
signals: queue lag, service time, CPU, RSS, event-loop lag, free disk,
provider 429 rate, retry rate and lease-expiry rate.

```ts
const report = recommendRhinoQAutopilot({
  schemaVersion: 1,
  observedAt: new Date().toISOString(),
  source: 'my-runtime-observer',
  metrics: { queueLagMs: 900, retryRate: 0.12 },
  envelope: { maxQueueLagMs: 500, maxRetryRate: 0.05 },
});
```

Recommendations contain the observed evidence, expected effect, guardrail and
rollback. They are always `action: 'review'` and `autoApply: false`. The
Workbench exposes the same report at `/admin/api/autopilot` behind the
operator gate.

The SDK also exposes `simulateRhinoQAutopilot()` and
`planRhinoQAutopilotCanary()`. They emit bounded what-if and approval artifacts
with `wouldMutate: false`, `approvalRequired: true` and `autoApply: false`; they
do not execute a runtime change. `executeRhinoQAutopilotCanary()` can run an
explicitly approved application-owned canary, bounds the task count and window,
requires rollback tokens and rolls back in reverse order when the health gate
fails. It never mutates Task state or retries an uncertain effect.

For application-owned settings, `createRhinoQAtomicOperationalConfigStore()`
provides a small stage/commit/rollback primitive with approval and revision
fencing:

```ts
const settings = createRhinoQAtomicOperationalConfigStore({ concurrency: 2 });
const change = settings.stage({ concurrency: 3 });
settings.commit(change, approval);
// If the canary is unhealthy:
settings.rollback(change, rollbackApproval);
```

This is an in-process transaction helper, not distributed persistence or a
Control Plane. Connect it to an application-owned durable settings store when
the deployment crosses a process boundary.
