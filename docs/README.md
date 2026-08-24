# RhinoQ documentation

**English** · [Tiếng Việt](./vi/README.md)

You do not need to read these pages in order. Start from the outcome you need.

## First run

| Goal | Read |
|---|---|
| see RhinoQ without infrastructure | [Five-minute quickstart](./quickstart.md) |
| add RhinoQ to an existing app | [Existing application guide](./start-here.md) |
| let the CLI choose a path | [One-command setup](./setup.md) |
| understand what code RhinoQ replaces | [What you do not build](./what-you-do-not-build.md) |
| understand application responsibilities | [What you still write](./what-you-still-write.md) |

## Choose a runtime

| Runtime | Read |
|---|---|
| native PostgreSQL queue | [PostgreSQL queue](./postgres-queue.md) |
| Node.js or NestJS | [Node.js integration](./nodejs.md) |
| existing BullMQ | [BullMQ evaluation](./evaluation-existing-queue.md) |
| custom runtime | [Native adoption](./native-adoption.md) |
| producer/worker split | [Runtime flows](./runtime-flows.md) |

## Build the user experience

- [Declare a Task](./task-declaration.md)
- [Owner Task API](./task-api.md)
- [Task Center and live updates](./live-task-ui.md)
- [React UI](./react-ui.md)
- [SSE and optional WebSocket](./realtime.md)
- [Files and artifacts](./artifact-storage.md)
- [TaskRunHandle](./task-run-handle.md)

## Add correctness where needed

- [Failure semantics](./failure-semantics.md)
- [Business verification](./business-verification.md)
- [Provider operations](./provider-operations.md)
- [Safe repair](./safe-repair.md)
- [Recovery](./recovery.md)
- [Notifications](./notifications.md)
- [Retention](./retention.md)

These are optional layers. A first Task integration does not need all of them.

## Operate and deploy

- [Terminal operations](./terminal-operations.md)
- [Workbench](./workbench.md)
- [Configuration](./configuration.md)
- [Operations](./operations.md)
- [Production checklist](./production-checklist.md)
- [Known limits](./production-readiness.md)
- [Compatibility matrix](./compatibility-matrix.md)
- [CLI reference](./cli.md)

## Architecture and extension reference

Read these when implementing a provider, runtime or RhinoQ contribution:

- [Architecture](./architecture.md)
- [Task Platform](./task-platform.md)
- [Application compiler](./application-compiler.md)
- [Project profile](./project-profile.md)
- [Plan Inspector](./plan-inspector.md)
- [Bounded Autopilot](./autopilot.md)
- [Processor packs](./processor-packs.md)
- [Module lifecycle](./module-lifecycle.md)
- [Control Plane boundary](./control-plane-boundary.md)
- [Feature matrix](./feature-matrix.md)

## Evidence and project planning

Benchmarks, research notes and upgrade plans are evidence for maintainers; they
are not integration instructions:

- [Benchmarks](./benchmarks.md)
- [Fault matrix](./fault-matrix.md)
- [Roadmap](./roadmap.md)
- [Consolidated upgrade plan (Tiếng Việt)](./ke-hoach-nang-cap-rhinoq.md)
- [Evidence archive](./evidence/)

Documentation distinguishes implemented, tested and production-evidenced
behavior. A local test or a documented API is not a production SLA.
