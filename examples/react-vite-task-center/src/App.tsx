import * as React from 'react';
import type { TaskSnapshot } from '@rhinoq/node';
import { createRhinoQComponents } from '@rhinoq/node/react';

const { RhinoQTaskCenter } = createRhinoQComponents(React);

export function App() {
  const [compactQueue, setCompactQueue] = React.useState(false);
  const params = new URLSearchParams(window.location.search);
  const initialTaskId = params.get('task') ?? undefined;
  const filter = params.get('filter');
  const sort = params.get('sort');
  const businessAliases: Record<string, string> = {
    'demo-export': 'order ORD-2048 customer ACME-88 provider job export-778',
    'demo-complete': 'order ORD-1984 archive annual-report',
    'demo-approval': 'budget MKT-Q3 request APR-412',
    'demo-confirmation': 'publish campaign CMP-2026 provider PUB-991',
    'demo-failed': 'invoice INV-1042 customer CUS-73 sync-502',
  };
  const jobNames: Record<string, string> = {
    'demo-export': 'Download product launch video',
    'demo-complete': 'Archive customer interview',
    'demo-approval': 'Approve licensed footage',
    'demo-confirmation': 'Publish campaign video',
    'demo-failed': 'Retry failed source download',
  };
  return <main className="application-shell">
    <header className="application-header">
      <a className="application-brand" href="/" aria-label="Acme home"><span>AC</span><strong>Acme Workspace</strong></a>
      <div className="application-view-switch" role="group" aria-label="Task Center layout">
        <button type="button" aria-pressed={!compactQueue} onClick={() => setCompactQueue(false)}>Full workspace</button>
        <button type="button" aria-pressed={compactQueue} onClick={() => setCompactQueue(true)}>Compact queue</button>
      </div>
    </header>
    <RhinoQTaskCenter
      apiUrl="/api/rhinoq/tasks"
      currentUser={{ name: 'Mai Nguyen' }}
      title="My activity"
      initialTaskId={initialTaskId}
      initialView={{
        search: params.get('q') ?? '',
        filter: filter === 'attention' || filter === 'active' || filter === 'finished' ? filter : 'all',
        sort: sort === 'oldest' || sort === 'type' ? sort : 'updated',
        ...(params.get('view') ? { savedFilterId: params.get('view')! } : {}),
      }}
      savedFilters={[
        { id: 'needs-review', label: 'Needs my review', filter: 'attention' },
        { id: 'active-work', label: 'Active work', filter: 'active' },
        { id: 'ready-files', label: 'Ready results', filter: 'finished', search: 'report' },
      ]}
      display={compactQueue ? {
        density: 'minimal', showHeader: false, showMetrics: false, showToolbar: false,
        showTaskIcon: false, showTaskState: false, pageSize: 3, maxListHeight: 360,
      } : undefined}
      {...(compactQueue ? {
        taskLabel: (task: TaskSnapshot) => jobNames[task.id] ?? task.type,
        taskDescription: () => undefined,
      } : {})}
      taskSearchText={(task) => businessAliases[task.id] ?? ''}
      retryCommandId={() => crypto.randomUUID()}
      openArtifact={(url) => window.open(url, '_blank', 'noopener,noreferrer')}
      openResult={(url) => window.open(url, '_blank', 'noopener,noreferrer')}
      onTaskChange={(taskId) => {
        const next = new URL(window.location.href);
        taskId ? next.searchParams.set('task', taskId) : next.searchParams.delete('task');
        window.history.replaceState(null, '', next);
      }}
      onViewChange={(view) => {
        const next = new URL(window.location.href);
        view.search ? next.searchParams.set('q', view.search) : next.searchParams.delete('q');
        view.filter !== 'all' ? next.searchParams.set('filter', view.filter) : next.searchParams.delete('filter');
        view.sort !== 'updated' ? next.searchParams.set('sort', view.sort) : next.searchParams.delete('sort');
        view.savedFilterId ? next.searchParams.set('view', view.savedFilterId) : next.searchParams.delete('view');
        window.history.replaceState(null, '', next);
      }}
      theme={{ accent: '#245eea', background: '#f4f7fb', foreground: '#10233f', radius: '8px' }}
    />
  </main>;
}
