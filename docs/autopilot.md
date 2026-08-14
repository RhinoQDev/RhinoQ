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
do not execute a runtime change. Bounded-auto remains intentionally absent until
adopter evidence, rollback tests and explicit operational authority exist.
