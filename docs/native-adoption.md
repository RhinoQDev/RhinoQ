# RhinoQ native adoption

RhinoQ native adoption upgrades an existing background-job application without
making SST, another cloud framework or a new queue the product boundary.

## Plan

```bash
npx rhinoq adopt --plan --out .rhinoq/adoption-plan.json
```

The bounded scanner inventories supported handler, producer, status-route,
polling, queue-listener, upload-proxy, retry, cancellation and provider-effect
patterns. The resulting `rhinoq-native-adoption-plan` is deterministic and
fingerprinted. Every diagnostic says what happened, why it matters, what
RhinoQ did, how to fix it and how to verify the decision.

The scanner does not import application source and does not claim that absence
of a match proves absence of a behavior. A truncated scan blocks promotion.

## Safety boundary

An external provider match never causes RhinoQ to generate an idempotency key
or confirmation policy. The application must review those business facts:

```text
provider call → stable application effect identity → idempotency policy
              → confirmation/readback policy → independent verification
```

Retry timers and cancellation code also require review so two retry owners are
not created and deployment shutdown is not mistaken for terminal user cancel.

## Shadow

```bash
npx rhinoq adopt --shadow --adapter custom --apply
```

`--shadow` aliases the portable observe-only integration. The existing runtime
keeps dispatch and cancellation ownership. RhinoQ records lifecycle evidence;
an application callback must resolve stable Task, owner and Execution identity.
`PostgresAdoptionReportStore` makes totals durable across replicas.

## Promote

Promotion is evidence evaluation, not an automatic mutation:

```bash
npx rhinoq adopt --promote \
  --from .rhinoq/adoption-plan.json \
  --evidence .rhinoq/shadow-report.json \
  --approve '<approval-key-from-plan>'
```

Save the JSON returned by `await rhino.runtime.adoptionReport()` as the shadow
report. The CLI converts those measured facts to promotion evidence; repeat
`--approve` only for decisions reviewed from the fingerprinted plan. A
precompiled `RhinoQAdoptionPromotionEvidence` artifact is also accepted for CI.

The evidence must match the plan fingerprint, include every approval, use
durable shadow reporting, contain at least one observed event, resolve every
identity and report no capability gap. A ready result points to the existing
explicit generator and keeps the reviewed `single`/`fanout` choice visible in
the command placeholder. It never transfers runtime ownership by
itself.

## Generated product handoff

When explicit queue-to-Task declarations are applied, RhinoQ writes a
non-overwriting `.rhinoq/adoption-handoff.json`. It records owner API, Task
Center, Workbench, terminal commands and acceptance checks. Authentication,
operator authorization, handler behavior, effect policy and business
verification remain marked as application decisions until configured.
