# Embeddable React Task UI

RhinoQ exposes optional components from `@rhinoq/node/react`. React is supplied
by the application, so backend-only users do not receive an added UI runtime.

```tsx
'use client';
import * as React from 'react';
import { createRhinoQComponents } from '@rhinoq/node/react';

export const { RhinoQTaskCenter, RhinoQTaskList, RhinoQTaskDetail, RhinoQProgress } =
  createRhinoQComponents(React);
```

For the complete embedded product surface, mount one component against the
application-owned owner API:

```tsx
<RhinoQTaskCenter
  apiUrl="/api/rhinoq/tasks"
  currentUser={{ name: session.user.name }}
  retryCommandId={(task) => crypto.randomUUID()}
  savedFilters={[
    { id: 'needs-review', label: 'Needs review', filter: 'attention' },
    { id: 'ready-results', label: 'Ready results', filter: 'finished' },
  ]}
  taskSearchText={(task) => businessAliases[task.id] ?? ''}
  onTaskChange={(taskId) => {
    history.replaceState(null, '', taskId ? `/activity?task=${encodeURIComponent(taskId)}` : '/activity');
  }}
  onViewChange={(view) => syncViewToURL(view)}
  theme={{ accent: '#245eea', radius: '8px' }}
/>
```

`RhinoQTaskCenter` includes overview metrics, application-supplied business ID
aliases, saved filters, deep-link callbacks, the live Task list, a responsive
right-side detail drawer, cancel/retry/approval/result actions, multi-artifact
metadata and preview, and motion-aware success/error notifications. Task rows stay keyed by
Task identity, so an authoritative progress update preserves focus, scroll and
the open drawer. The drawer traps keyboard focus, closes with `Escape`, and
returns focus to its Task card. Pass an existing `ApplicationTaskClient` through `client`
instead of `apiUrl` when the host needs custom fetch or header behavior.

`currentUser` is presentation only. It is never sent as an owner or tenant
claim. The route behind `apiUrl` must derive both identities from the
authenticated application session. A retry button is disabled until
`retryCommandId` is supplied because the UI must not invent durable command
identity. Confirmation of an uncertain provider result remains an authorized
operator/application workflow; owner approvals should use the versioned
waitpoint API instead of turning UI text into confirmation evidence.
Webhook waitpoints therefore remain read-only in the end-user drawer.

`taskSearchText` is the explicit bridge for order IDs, customer IDs or provider
aliases owned by the application. RhinoQ does not add those identifiers to its
browser snapshot or guess which business fields are safe to expose. Saved view
definitions can be stored by the host; `initialView` and `onViewChange` let the
host encode them in its router without coupling the component to React Router
or Next.js.

## Large queues and application-owned rows

The full workspace is not mandatory. A video downloader, import queue or other
high-volume screen can show only the user-supplied job name and progress inside
a compact, independently scrolling list. `pageSize` limits DOM work and reveals
the next batch with an accessible **Load more** action; it does not change the
authoritative server query limit.

```tsx
<RhinoQTaskCenter
  apiUrl="/api/rhinoq/tasks"
  query={{ types: ['video.download'], limit: 50 }}
  taskLabel={(task) => videoTitles[task.id] ?? 'Video download'}
  taskDescription={() => undefined}
  display={{
    density: 'minimal',
    showHeader: false,
    showMetrics: false,
    showToolbar: false,
    showTaskIcon: false,
    showTaskState: false,
    showProgress: true,
    pageSize: 10,
    maxListHeight: 480,
  }}
/>
```

Applications can independently toggle the header, metrics, toolbar, icon,
state, progress and update time. Set `detailMode: 'none'` and use
`onTaskChange` when the host owns navigation. `renderTask` replaces an entire
row while RhinoQ continues to own live snapshots, stale-version rejection,
search/filter ordering and progressive batching:

```tsx
<RhinoQTaskCenter
  client={taskClient}
  display={{ density: 'compact', detailMode: 'none', pageSize: 20 }}
  renderTask={({ task, label, progressPercent, open }) => (
    <button onClick={open} className="video-job">
      <span>{label}</span><span>{progressPercent ?? 0}%</span>
    </button>
  )}
  onTaskChange={(taskId) => taskId && router.navigate(`/downloads/${taskId}`)}
/>
```

For complete markup control, use `createUseRhinoTasks(React)` and
`RhinoQProgress` instead of `RhinoQTaskCenter`. This headless path keeps the
same Task store and realtime semantics without rendering the RhinoQ workspace.

Artifact metadata is browser-safe and never includes its storage reference.
Preview and download call the owner-scoped resolver at action time, so expired
links can be refreshed without persisting credentials in React state.

The lower-level components remain available for applications that own their
own shell or router:

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

## React, Vite and Next.js

The component contract is ordinary React and does not import Next.js. React
SPA/Vite applications can mount it in their existing root and point `apiUrl`
at a same-origin backend route. Next.js applications should place the factory
in a `'use client'` module and mount the same application-owned route from a
Route Handler. Server components may pass display data and theme tokens into
the client component, but never an operator token or private storage reference.

Run the complete [React/Vite reference application](../examples/react-vite-task-center/README.md)
against `rhinoq dev --demo` to exercise SSE, business-key search, saved-filter
deep links, approval safety, artifact preview, keyboard focus, retry/cancel
notifications and the responsive layout without adding Next.js.

See the Next.js helper in
`examples/nextjs-bullmq-stripe/app/rhinoq-task-components.tsx` and the live
application-owned endpoint in `app/api/tasks/route.ts`. The example deliberately
keeps Gateway credentials on the server. NestJS serves the same owner API; its
frontend uses these components in exactly the same way.

## Visual contract

The repository checks both the standalone Task Center and the production-built
React/Vite reference application at desktop and mobile sizes. The Playwright
contract covers keyed realtime updates, search/deep links, focus containment,
approval safety and artifact preview, and fails on horizontal overflow or changes to the deliberate
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
