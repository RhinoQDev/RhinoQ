# Business verification onboarding

RhinoQ onboarding has two separate completion points. Do not collapse them.

## 1. Task visibility installed

Runtime events create durable Tasks and Executions. Users receive progress,
attempt history, SSE with polling fallback and owner-scoped Task Center reads.
A runtime `succeeded` event proves only that the runtime reported completion.

## 2. Business outcome verification installed

The application checks the real invariant with its provider credentials and
records one of three outcomes:

| Readback | Verification | Task meaning |
|---|---|---|
| Expected output is present and matches | `verified` | May become `succeeded` |
| Output is missing or mismatched | `mismatch` | `uncertain`; operator review/repair |
| Readback timed out or was denied | `unverifiable` | `uncertain`; do not retry mutation blindly |

The verifier is application-owned correctness. RhinoQ supplies durable
verification evidence, incident explanation and guarded recovery, but cannot
invent whether a report, email, refund or other business effect happened.

The [`report.export` example](../examples/report-export/) demonstrates both
milestones. Its normal path writes a report, independently reads it back,
compares the checksum, records `verified` and closes the Task. Its broken path
records the successful Execution but no output, records `mismatch` and leaves
the Task `uncertain`.

Recovery remains preview-first. A different actor approves the repair, the
idempotency fence is consumed before provider mutation, and the Task closes
only after readback plus post-check. A provider timeout consumes the fence as
`uncertain`; replay returns the stored result and never writes again.

## Acceptance checklist

- Stable Task, Execution and runtime identities.
- Stable owner and tenant identity from server-side authentication.
- Normal success includes independent provider readback.
- Missing output is `mismatch`, not technical success.
- Timeout/permission failure is `unverifiable`, not missing or present.
- Private result references never reach owner JSON or HTML.
- Recovery has preview, separate approval, idempotency and post-check.
- Unknown provider result never authorizes blind retry.
