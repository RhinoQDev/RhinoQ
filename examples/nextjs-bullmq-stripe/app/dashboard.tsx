'use client';

import { useEffect, useState } from 'react';
import { ApplicationTaskClient } from '@rhinoq/node/browser';
import { RhinoQTaskList } from './rhinoq-task-components';

const taskClient = new ApplicationTaskClient({ url: '/api/tasks' });

type DemoState = Record<string, unknown> & { orderId?: string; task?: { state?: string }; job?: string; provider?: { state?: string }; finding?: { status?: string }; repair?: { state?: string } };

export default function Dashboard() {
  const [state, setState] = useState<DemoState>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  async function refresh() {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (response.ok) setState(await response.json());
  }
  async function act(action: string) {
    setBusy(action); setError('');
    try {
      const response = await fetch('/api/demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, orderId: state.orderId }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(''); }
  }
  useEffect(() => { refresh(); const timer=setInterval(refresh, 1000); return () => clearInterval(timer); }, []);
  const rows = [
    ['BullMQ job', state.job ?? 'not started'],
    ['RhinoQ Task', state.task?.state ?? 'not started'],
    ['Provider operation', state.provider?.state ?? 'not started'],
    ['Business finding', state.finding?.status ?? 'none'],
    ['Repair plan', state.repair?.state ?? 'none'],
  ];
  return <section className="panel">
    <div className="rail">{rows.map(([label,value]) => <div className="truth" key={label}><small>{label}</small><strong data-state={value}>{value}</strong></div>)}</div>
    <div className="actions">
      <button onClick={() => act('create')} disabled={!!busy}>1. Break it</button>
      <button onClick={() => act('recheck')} disabled={!state.orderId || !!busy}>2. Recheck Stripe</button>
      <button onClick={() => act('propose')} disabled={!state.finding || !!busy}>3. Propose</button>
      <button onClick={() => act('preview')} disabled={!state.repair || !!busy}>4. Dry-run</button>
      <button onClick={() => act('approve')} disabled={!state.repair || !!busy}>5. Approve</button>
      <button onClick={() => act('execute')} disabled={!state.repair || !!busy}>6. Repair + verify</button>
    </div>
    {busy && <p className="note">Running {busy}…</p>}
    {error && <p className="error">{error}</p>}
    <div className="embedded-task-center">
      <div className="embedded-task-copy">
        <p className="eyebrow">EMBEDDED TASK CENTER</p>
        <h2>Background work, inside the product</h2>
        <p>This list reads the application-owned Task endpoint. No operator token reaches the browser.</p>
      </div>
      <RhinoQTaskList client={taskClient} pollIntervalMs={1000} />
    </div>
    <details><summary>Evidence snapshot</summary><pre>{JSON.stringify(state, null, 2)}</pre></details>
  </section>;
}
