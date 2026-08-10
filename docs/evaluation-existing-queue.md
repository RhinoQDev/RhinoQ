# Evaluate RhinoQ in an existing queue application

This protocol is for the next real integration. It is deliberately
runtime-neutral: BullMQ is the first tested bridge, not a requirement of the
product. If the application uses another queue, record the missing adapter
work separately instead of presenting BullMQ-specific behavior as a RhinoQ
core requirement.

The purpose is not to prove that API calls return `200`. It is to answer:

> Does RhinoQ remove enough user-facing task plumbing to justify one more
> dependency while leaving business handlers and the current runtime intact?

## Use the exact candidate

The npm registry currently contains `beta.1` and `beta.2`. The corrected
Task-only, waitpoint, SSE and fan-out contract is the `beta.9` candidate on
`main`.
Until it is published, pack it from this checkout:

```powershell
cd C:\path\to\rhinoq\sdks\node
npm ci
npm test
npm pack
```

Install the resulting tarball by absolute path in the target application:

```powershell
npm install C:\path\to\rhinoq\sdks\node\rhinoq-node-0.1.0-beta.9.tgz pg
```

Record all four identities in the report:

- RhinoQ Git commit;
- npm package version or tarball name;
- installation profile: Task-only schema version 7 (isolated Task tables), or legacy full
  migration 017;
- target application commit.

If any identity is missing, the result cannot be reproduced.

## Choose two tasks before changing code

Pick tasks with different shapes:

1. one single-execution task (`1 Task = 1 runtime job`);
2. one fan-out or multi-attempt task (`1 Task = N executions`).

At least one should call an external dependency where timeout or ambiguous
completion is realistic. For each task, write down before integration:

- business outcome users care about;
- current queue/runtime and retry policy;
- current status, progress, result and cancellation code;
- ownership/authorization check;
- whether the runtime charges money or causes an irreversible effect.

Do not rewrite handlers merely to make RhinoQ fit. A required handler rewrite
is a product finding.

## Measure the baseline

Count only code involved in the two selected tasks:

- status/result endpoints;
- task/result database or Redis records;
- SSE/polling/reconnect glue;
- progress aggregation;
- ownership checks;
- cancellation/retry orchestration;
- tests for those paths.

Record files and lines before integration. After integration, report lines
added, lines removed and old components that could actually be deleted. Code
that “could probably be deleted later” counts as zero removed.

Also record operational additions:

- new datastore;
- new long-running process;
- new secret or credential class;
- migration/deployment step;
- browser request added per polling interval.

## Integrate at the narrow boundary

Keep the application runtime as source of execution. RhinoQ owns the durable
user-facing Task snapshot.

For BullMQ:

- application still calls `queue.add()`;
- call `track()` with the stable BullMQ job ID;
- use `terminalProjection: 'single-execution'` only when one job is the whole
  Task;
- use `terminalProjection: 'execution-only'` for fan-out, then let application
  business logic terminalize the aggregate Task;
- persist per-item artifact references on their Execution;
- do not claim that RhinoQ removes, cancels or retries BullMQ jobs.

For another runtime, map these same observations without copying Task state
machine rules into the adapter:

```text
runtime identity → Execution binding
waiting/active   → Execution lifecycle observation
progress         → monotonic Task progress
item result      → Execution result reference
aggregate result → Task result reference
```

If the adapter has to implement progress monotonicity, cancellation outcomes
or Task transition legality itself, stop and report an architecture gap.

## Required adversarial scenarios

Run these against the integrated application, not only SDK mocks:

1. same progress event delivered twice;
2. stale progress arrives after newer progress;
3. completed count attempts to move backwards;
4. fan-out item 1 completes while other items are running;
5. one fan-out item fails and records a bounded reason;
6. process restarts after runtime enqueue but before/after `track()`;
7. browser reloads while Task is running;
8. two tabs receive responses in opposite order;
9. cancellation wins before execution starts;
10. execution finishes while cancellation is being requested (`too_late`);
11. owner A requests owner B's Task/result;
12. Gateway or PostgreSQL is temporarily unavailable;
13. external provider accepted a request but its result is unknown.

For scenario 13, RhinoQ must not turn “unknown” into success or a blind retry.
If the current product cannot represent the provider state without custom
application plumbing, report that fact; do not emulate an unimplemented
ProviderOperation.

## Browser evidence

Use at least a minimal polling page with two tabs. Record:

- time from user action to first visible Task;
- polling interval and requests per minute;
- stale snapshot rendered, if any;
- duplicate render, if any;
- final cancellation outcome shown to the user;
- time to authorized result access;
- behavior during a 10–30 second API outage and after reconnect.

Screenshots or a short recording are useful, but assertions and network traces
are stronger evidence than visual appearance alone.

## Return this verdict

Use one of:

- **GO:** both handlers unchanged, correctness scenarios pass, and durable
  task plumbing is materially smaller;
- **CONDITIONAL:** contract helps but deployment/integration cost or one
  correctness gap remains;
- **NO-GO:** handler/runtime migration is required, RhinoQ adds as much glue as
  it removes, or an authorization/correctness scenario fails.

Include:

```text
RhinoQ commit/package/migration:
Application commit/runtime:
Task A / Task B:
Handler lines changed:
Lifecycle plumbing added / removed:
Processes / datastores / credentials added:
Scenarios passed / failed / not run:
Browser p50/p95 time to first visible Task:
Three strongest benefits:
Three highest integration costs:
Verdict and the single condition that would change it:
```

Do not report production readiness from this exercise. It validates adoption
and Task correctness in one application, not retention, restore, throughput,
fault tolerance or organization-wide authorization.
