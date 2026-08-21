# TaskRunHandle

`TaskRunHandle` is the owner-facing convenience facade for a Task that has
already been created or dispatched. It composes `TaskStore`; it is not a second
queue, state machine or retry policy.

```ts
import { TaskRunHandle } from '@rhinoq/node';

const run = new TaskRunHandle(ownerClient, taskId, {
  taskCenterPath: '/app/tasks',
  pollIntervalMs: 1_000,
});

run.start();
const finalSnapshot = await run.wait({ timeoutMs: 60_000 });
if (finalSnapshot.state === 'succeeded') {
  const result = await run.result();
  console.log(run.url());
}
```

The handle offers `start()`, `stop()`, `refresh()`, `wait()`, `cancel()`,
`result()`, `downloadResult()`, `subscribe()` and `url()`. `wait()` stops on a
terminal state and supports an abort signal or bounded timeout. Live SSE is
preferred when the client supplies it; the existing bounded polling fallback
remains the source of updates.

`url()` creates only a relative owner-facing path (or resolves it against an
explicit origin). It rejects query strings and fragments so credentials cannot
accidentally become part of a shared Task link. Business authentication,
tenant checks and external-effect confirmation remain application/runtime
responsibilities.
