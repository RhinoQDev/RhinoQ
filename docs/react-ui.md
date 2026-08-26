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

The default components are zero-config visually: each one includes the scoped
RhinoQ stylesheet, responsive card/detail layouts, state-aware color, progress
transitions, loading skeletons and reduced-motion handling. Render
`RhinoQStyles` once and pass `unstyled` to individual components when a page
contains many RhinoQ surfaces, or pass `unstyled` without `RhinoQStyles` when
the host design system owns every rule.

```tsx
export const { RhinoQStyles, RhinoQTaskList } = createRhinoQComponents(React);

<>
  <RhinoQStyles />
  <RhinoQTaskList client={taskClient} unstyled
    theme={{ accent: '#7c3aed', surface: '#fff', radius: '18px' }} />
</>
```

Pass a `theme` object to override accent, background, surface, foreground,
muted, border, success, warning, danger, radius and font-family tokens. Motion
is deliberately subtle and is disabled under `prefers-reduced-motion`.
Authentication remains in the application's `TaskBrowserClient`; do not put
operator credentials in browser code.

See the Next.js helper in
`examples/nextjs-bullmq-stripe/app/rhinoq-task-components.tsx` and the live
application-owned endpoint in `app/api/tasks/route.ts`. The example deliberately
keeps Gateway credentials on the server. NestJS serves the same owner API; its
frontend uses these components in exactly the same way.

## Visual contract

The repository checks the standalone Task Center at 1440×1024 and 390×844. The
Playwright contract fails on horizontal overflow or changes to the deliberate
26px title and 8px Task-card radius, and attaches full-page desktop/mobile PNGs
to the CI run for review. Motion is disabled to make the evidence deterministic.

```bash
cd sdks/node
npm run build
npx playwright install chromium
npm run test:visual
```

The screenshots and trace are written under `test-results/`; CI retains them as
the `task-center-visual-<commit>` artifact. This contract checks layout and
readability, while API/component tests remain authoritative for behavior.
