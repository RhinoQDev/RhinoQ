# Project profile

`defineRhinoQProject()` is the low-code composition entry point for a Node
application. It binds one PostgreSQL pool, one execution profile, one identity
source and one operator token around the existing typed Task compiler.

```ts
const project = defineRhinoQProject({
  pool,
  profile: { name: 'reports', adapters: [bullmqAdapter] },
  identity: { ownerFromNodeRequest },
  http: { operatorToken: process.env.RHINOQ_OPERATOR_TOKEN! },
  tasks: (rhinoq) => ({
    exportReport: rhinoq.task('report.export', async (input, context) => {
      return generateReport(input, context);
    }),
  }),
});

const application = await project.start();
```

The started application exposes typed dispatchers, registered worker handlers,
the owner Task API, Task Center and operator Workbench from the same
composition. The project identity is required to keep owner reads scoped; the
operator token is required because Workbench reads across owners.

`start()` accepts runtime-safe overrides such as tracing, metrics and artifact
providers. It does not allow a caller to replace the project pool or identity
accidentally. The compiler still rejects duplicate or undeclared Task names,
and Go/runtime adapters remain authoritative for leases, retries and state
transitions.

This is a composition shortcut, not automatic business configuration. The
application still owns authentication, tenant policy, handler behavior,
provider credentials and the definition of a correct business result.

The setup preview also records detected framework/runtime/database/storage
capabilities in `.rhinoq/setup.json` (schema v2). Detection is advisory: it
selects a safe adapter/template and shows the exact mount surface, but it does
not install packages, infer owner identity or silently enable a provider.

Task factories may declare `task`, `batch`, `media`, `effect` or `schedule`.
`resources` and `schedule` compile into a read-only execution capsule covering
runtime budget, workspace/disk, GPU/region/codec requirements and the schedule
expression. Occurrence creation and resource enforcement remain runtime-owned.
