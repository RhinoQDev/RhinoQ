# Safe repair workflow

RhinoQ repairs are registered application code, never arbitrary SQL received
from a browser or notification. The workflow is:

```text
propose -> preview -> approve by another actor -> recheck precondition
        -> apply with plan ID as idempotency key -> verify -> resolve Finding
```

Safety rules:

- the proposer cannot approve the same plan;
- approval requires a reason;
- preview returns a human summary and a stable precondition token;
- execution reruns preview immediately before mutation;
- a changed token makes the plan `stale` and calls no mutation;
- apply receives the repair ID as its idempotency key;
- an unknown apply/verify result is `uncertain`, never retried blindly;
- the Finding resolves only after the handler's independent verification passes.

Migration `019_safe_repairs.sql` stores the plan, actors, preview, approval,
state and outcome. Register in-process handlers with `NewRepairRegistry`, or
allowlist signed application callbacks with `RHINOQ_REPAIR_CALLBACKS_JSON`.
The Agent and loopback Workbench expose propose, preview, approve and execute;
both call the Go application workflow and neither accepts arbitrary SQL.

```json
{
  "order.mark-refunded": {
    "url": "https://app.example.com/internal/rhinoq/repair",
    "secret": "at-least-32-bytes",
    "timeout": "10s"
  }
}
```

Callback requests carry `X-RhinoQ-Repair-Signature`, an action and the bounded
parameters stored with the plan. Apply also carries the repair ID as
`Idempotency-Key`. Plain HTTP is accepted only on loopback unless a private
development deployment opts in explicitly.
