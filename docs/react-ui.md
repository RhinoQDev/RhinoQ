# Embeddable React Task UI

RhinoQ exposes optional components from `@rhinoq/node/react`. React is supplied
by the application, so backend-only users do not receive an added UI runtime.

```tsx
'use client';
import * as React from 'react';
import { createRhinoQComponents } from '@rhinoq/node/react';

export const { RhinoQTaskList, RhinoQTaskDetail, RhinoQProgress } =
  createRhinoQComponents(React);
```

```tsx
<RhinoQTaskList
  client={taskClient}
  onSelectTask={(task) => router.push(`/tasks/${task.id}`)}
/>
<RhinoQTaskDetail client={taskClient} taskId={taskId}
  retryCommandId={() => crypto.randomUUID()} />
```

The components reuse `TaskStore` and `TaskListStore`, including SSE, stale
version rejection and polling fallback. They provide loading, error and empty
states; cancel/retry/result actions based on server capabilities; accessible
status announcements and native progress; and CSS custom-property theme tokens.

Pass a `theme` object to override accent, background, foreground, muted, border
and radius tokens. Authentication remains in the application's `TaskBrowserClient`;
do not put operator credentials in browser code.

See the Next.js helper in
`examples/nextjs-bullmq-stripe/app/rhinoq-task-components.tsx`. NestJS serves
the same owner API; its frontend uses these components in exactly the same way.
