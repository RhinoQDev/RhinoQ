/**
 * The Workbench page, inlined.
 *
 * No CDN, no build step, no framework: an operator page that cannot load is
 * worse than no operator page, and the moment it needs a bundler it stops
 * being something an application can mount in one line.
 */
export const WORKBENCH_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>RhinoQ Workbench</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfbfa; --panel: #fff; --line: #e3e3e0; --ink: #1a1a18;
    --muted: #6b6b66; --accent: #2f5d50; --warn: #8a5a00; --bad: #9b2c2c;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16171a; --panel: #1d1f23; --line: #2c2f35; --ink: #e8e8e6;
      --muted: #9a9a95; --accent: #7fc7ae; --warn: #d9a441; --bad: #e07a7a;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
  }
  header {
    padding: 14px 20px; border-bottom: 1px solid var(--line);
    display: flex; gap: 14px; align-items: baseline; flex-wrap: wrap;
  }
  h1 { font-size: 15px; margin: 0; font-weight: 650; letter-spacing: -0.01em; }
  .muted { color: var(--muted); }
  main { padding: 20px; display: grid; gap: 20px; max-width: 1100px; }
  .buckets { display: flex; gap: 8px; flex-wrap: wrap; }
  .bucket {
    border: 1px solid var(--line); background: var(--panel); border-radius: 8px;
    padding: 10px 14px; cursor: pointer; min-width: 108px; text-align: left;
    color: inherit; font: inherit;
  }
  .bucket[aria-pressed="true"] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
  .bucket b { display: block; font-size: 20px; font-weight: 620; }
  .panel {
    border: 1px solid var(--line); background: var(--panel);
    border-radius: 8px; overflow: hidden;
  }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { font-weight: 600; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
  tr:last-child td { border-bottom: 0; }
  tbody tr[data-id] { cursor: pointer; }
  tbody tr[data-id]:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
  code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .pill { padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); font-size: 12px; }
  .s-failed, .s-stalled { color: var(--bad); }
  .s-succeeded { color: var(--accent); }
  .s-cancel_requested, .s-uncertain { color: var(--warn); }
  .empty { padding: 28px; text-align: center; color: var(--muted); }

  /* Loading is a state, not an absence: an operator must be able to tell
     "nothing yet" from "nothing there". */
  .skel {
    display: inline-block; height: 0.75em; min-width: 3.5em; border-radius: 4px;
    background: linear-gradient(90deg,
      color-mix(in srgb, var(--ink) 9%, transparent) 25%,
      color-mix(in srgb, var(--ink) 16%, transparent) 37%,
      color-mix(in srgb, var(--ink) 9%, transparent) 63%);
    background-size: 400% 100%; animation: shimmer 1.4s ease infinite;
  }
  .skel.w-lg { min-width: 12em; }
  @keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }

  /* A row that just changed gets a moment of attention, then stops shouting. */
  @keyframes flash {
    from { background: color-mix(in srgb, var(--accent) 26%, transparent); }
    to { background: transparent; }
  }
  tr.changed td { animation: flash 1.1s ease-out; }

  .live { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
  .live[data-state="live"] .dot { background: var(--accent); animation: pulse 2s ease-in-out infinite; }
  .live[data-state="polling"] .dot { background: var(--warn); }
  .live[data-state="down"] .dot { background: var(--bad); }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
  @media (prefers-reduced-motion: reduce) {
    .skel, .live[data-state="live"] .dot { animation: none; }
    tr.changed td { animation: none; }
  }
  button.act {
    font: inherit; padding: 5px 11px; border-radius: 6px; cursor: pointer;
    border: 1px solid var(--line); background: transparent; color: inherit;
  }
  button.act:disabled { opacity: 0.45; cursor: not-allowed; }
  .err { color: var(--bad); padding: 10px 20px; }
  .head { padding: 10px 12px; border-bottom: 1px solid var(--line); display: flex; gap: 12px; align-items: center; }
</style>
</head>
<body>
<header>
  <h1>RhinoQ Workbench</h1>
  <span class="muted" id="mode"></span>
  <span class="live muted" id="live" data-state="connecting" style="margin-left:auto">
    <span class="dot"></span><span id="liveText">connecting…</span>
  </span>
</header>
<div class="err" id="err" hidden></div>
<main>
  <div class="buckets" id="buckets"></div>
  <div class="panel">
    <div class="head"><strong id="listTitle">Tasks</strong><span class="muted" id="listNote"></span></div>
    <div class="scroll"><table id="list"><tbody></tbody></table></div>
  </div>
  <div class="panel" id="detailPanel" hidden>
    <div class="head">
      <strong id="detailTitle"></strong>
      <span class="muted" id="detailMeta"></span>
      <button class="act" id="cancelBtn" style="margin-left:auto" hidden>Request cancellation</button>
    </div>
    <div class="scroll"><table id="detail"><tbody></tbody></table></div>
  </div>
</main>
<script>
const base = location.pathname.replace(/\/+$/, '');
let snap = null;          // last payload the server sent
let active = 'running';
let currentId = null;
let source = null;
let pollTimer = null;
let failures = 0;
let previousRows = new Map();
let previousItems = new Map();

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

function live(state, text) {
  $('live').dataset.state = state;
  $('liveText').textContent = text;
}

function fail(error) {
  $('err').hidden = false;
  $('err').textContent = error.message;
}

function ago(iso) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 90) return Math.round(seconds) + 's';
  if (seconds < 5400) return Math.round(seconds / 60) + 'm';
  if (seconds < 172800) return Math.round(seconds / 3600) + 'h';
  return Math.round(seconds / 86400) + 'd';
}

// The first paint must say "loading", not "empty": an operator has to be able
// to tell a quiet system from one that has not answered yet.
function skeleton() {
  $('buckets').innerHTML = Array.from({ length: 6 }, () =>
    '<div class="bucket" aria-hidden="true"><b><span class="skel"></span></b><br><span class="skel"></span></div>').join('');
  $('list').querySelector('tbody').innerHTML = Array.from({ length: 3 }, () =>
    '<tr><td><span class="skel w-lg"></span></td><td><span class="skel"></span></td><td><span class="skel"></span></td></tr>').join('');
}

function renderBuckets() {
  $('mode').textContent = snap.actions ? 'actions enabled' : 'read-only';
  $('buckets').innerHTML = snap.states.map((state) =>
    '<button class="bucket" data-state="' + state + '" aria-pressed="' + (state === active) +
    '"><b class="s-' + state + '">' + (snap.counts[state] ?? 0) + '</b><span class="muted">' +
    state + '</span></button>').join('');
  for (const button of document.querySelectorAll('.bucket[data-state]')) {
    button.onclick = () => { active = button.dataset.state; renderBuckets(); renderList(); };
  }
}

function renderList() {
  const tasks = (snap.lists && snap.lists[active]) || [];
  $('listTitle').textContent = 'Tasks · ' + active;
  $('listNote').textContent = tasks.length ? tasks.length + ' shown' : '';
  const body = $('list').querySelector('tbody');
  if (!tasks.length) {
    previousRows = new Map();
    body.innerHTML = '<tr><td class="empty">Nothing in ' + esc(active) + '.</td></tr>';
    return;
  }
  const next = new Map();
  body.innerHTML = '<tr><th>Task</th><th>Type</th><th>Items</th><th>Progress</th><th>Idle</th></tr>' +
    tasks.map((task) => {
      const counts = task.executionCounts || {};
      const done = (counts.succeeded ?? 0) + (counts.failed ?? 0) + (counts.cancelled ?? 0);
      const signature = task.entityVersion + ':' + task.state + ':' + done;
      const changed = previousRows.has(task.id) && previousRows.get(task.id) !== signature;
      next.set(task.id, signature);
      return '<tr data-id="' + esc(task.id) + '"' + (changed ? ' class="changed"' : '') +
        '><td><code>' + esc(task.id) + '</code></td><td>' + esc(task.type) + '</td><td>' +
        done + ' / ' + (counts.total ?? 0) + '</td><td>' + (task.progress?.completed ?? 0) +
        (task.progress?.total ? ' / ' + task.progress.total : '') +
        '</td><td class="muted">' + ago(task.updatedAt) + '</td></tr>';
    }).join('');
  previousRows = next;
  for (const row of body.querySelectorAll('tr[data-id]')) {
    row.onclick = () => select(row.dataset.id);
  }
}

function renderDetail() {
  const detail = snap.detail;
  if (!currentId || !detail || detail.task.id !== currentId) {
    return;
  }
  $('detailPanel').hidden = false;
  $('detailTitle').textContent = detail.task.id;
  $('detailMeta').textContent = detail.task.state + ' · v' + detail.task.entityVersion +
    ' · cancellation ' + (detail.task.cancellation?.status ?? 'none');
  const cancellable = ['pending', 'queued', 'running'].includes(detail.task.state);
  $('cancelBtn').hidden = !(snap.actions && cancellable);
  const next = new Map();
  $('detail').querySelector('tbody').innerHTML =
    '<tr><th>Item</th><th>Attempt</th><th>State</th><th>Runtime job</th><th>Outcome</th></tr>' +
    detail.items.map((item) => {
      const key = item.executionId;
      const signature = item.state + ':' + item.attempt + ':' + (item.failureReason ?? '');
      const changed = previousItems.has(key) && previousItems.get(key) !== signature;
      next.set(key, signature);
      return '<tr' + (changed ? ' class="changed"' : '') + '><td><code>' + esc(item.itemKey) +
        '</code></td><td>' + item.attempt + '</td><td class="s-' + esc(item.state) + '">' +
        esc(item.state) + '</td><td><code class="muted">' + esc(item.externalId ?? '—') +
        '</code></td><td>' + esc(item.failureReason ?? (item.hasResult ? 'result recorded' : '')) +
        '</td></tr>';
    }).join('');
  previousItems = next;
}

function render() {
  if (!snap) return;
  renderBuckets();
  renderList();
  renderDetail();
  $('err').hidden = true;
}

function select(taskId) {
  if (currentId === taskId) return;
  currentId = taskId;
  previousItems = new Map();
  $('detailPanel').hidden = false;
  $('detail').querySelector('tbody').innerHTML =
    '<tr><td><span class="skel w-lg"></span></td><td><span class="skel"></span></td><td><span class="skel"></span></td></tr>';
  connect();   // re-subscribe so the server streams this Task too
}

// Server-sent events. The server watches the store and writes only when
// something actually changed, so the console updates on its own — no reload,
// and no browser polling a table it cannot see into.
function connect() {
  if (source) { source.close(); source = null; }
  if (typeof EventSource !== 'function') { startPolling(); return; }
  const url = base + '/api/stream' + (currentId ? '?task=' + encodeURIComponent(currentId) : '');
  live('connecting', 'connecting…');
  source = new EventSource(url);
  source.onopen = () => { failures = 0; stopPolling(); live('live', 'live'); };
  // An adapter that buffers a Response never errors and never sends: the
  // request simply hangs. onerror cannot rescue that, so time it out.
  const opened = Date.now();
  const watchdog = setInterval(() => {
    if (snap || !source) { clearInterval(watchdog); return; }
    if (Date.now() - opened > 8000) {
      clearInterval(watchdog);
      source.close(); source = null;
      live('polling', 'polling');
      startPolling();
    }
  }, 1000);
  source.addEventListener('state', (event) => {
    failures = 0;
    live('live', 'live');
    try { snap = JSON.parse(event.data); render(); } catch (error) { fail(error); }
  });
  source.addEventListener('failure', (event) => {
    try { fail(new Error(JSON.parse(event.data).message)); } catch { fail(new Error('stream failed')); }
  });
  source.onerror = () => {
    failures += 1;
    // A mount that cannot stream a Response is a real deployment, not something
    // to argue with. Fall back rather than sit there showing nothing.
    if (failures >= 3) { source.close(); source = null; live('polling', 'polling'); startPolling(); }
    else { live('connecting', 'reconnecting…'); }
  };
}

function startPolling() {
  if (pollTimer) return;
  const tick = async () => {
    try {
      const response = await fetch(base + '/api/overview', { headers: { accept: 'application/json' } });
      const overview = await response.json();
      if (!response.ok) throw new Error(overview.message || overview.code);
      const lists = {};
      for (const state of overview.states) {
        const listResponse = await fetch(base + '/api/tasks?state=' + encodeURIComponent(state));
        lists[state] = ((await listResponse.json()).tasks) ?? [];
      }
      let detail;
      if (currentId) {
        const detailResponse = await fetch(base + '/api/tasks/' + encodeURIComponent(currentId));
        if (detailResponse.ok) detail = await detailResponse.json();
      }
      snap = Object.assign({}, overview, { lists }, detail ? { detail } : {});
      render();
      live('polling', 'polling');
    } catch (error) { fail(error); live('down', 'disconnected'); }
  };
  void tick();
  pollTimer = setInterval(tick, 3000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

$('cancelBtn').onclick = async () => {
  const detail = snap && snap.detail;
  if (!detail) return;
  $('cancelBtn').disabled = true;
  $('cancelBtn').textContent = 'Requesting…';
  try {
    const response = await fetch(base + '/api/tasks/' + encodeURIComponent(detail.task.id) + '/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: detail.task.entityVersion }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || body.code);
    // No manual refresh: the stream carries the new state.
  } catch (error) {
    fail(error);
  } finally {
    $('cancelBtn').disabled = false;
    $('cancelBtn').textContent = 'Request cancellation';
  }
};

// Idle labels drift on their own; refresh them without re-reading the store.
setInterval(() => { if (snap) renderList(); }, 10000);

skeleton();
connect();
</script>
</body>
</html>`;
