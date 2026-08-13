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
  header nav { display: flex; gap: 12px; align-items: center; }
  header a { color: inherit; text-decoration: none; }
  header a:hover { text-decoration: underline; text-underline-offset: 3px; }
  h1 { font-size: 15px; margin: 0; font-weight: 650; letter-spacing: -0.01em; }
  .muted { color: var(--muted); }
  main { padding: 20px; display: grid; gap: 20px; max-width: 1100px; }
  .buckets { display: flex; gap: 8px; flex-wrap: wrap; }
  .runtime-grid { display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px;padding:12px; }
  .runtime-card { border:1px solid var(--line);border-radius:7px;padding:11px;display:grid;gap:8px; }
  .runtime-card .top { display:flex;justify-content:space-between;gap:8px; }
  .runtime-counts { display:grid;grid-template-columns:repeat(3,1fr);gap:6px; }
  .runtime-counts span { color:var(--muted);font-size:12px; }.runtime-counts b { display:block;color:var(--ink);font-size:16px; }
  .health-healthy { color:var(--accent); }.health-degraded,.health-unknown { color:var(--warn); }.health-unavailable { color:var(--bad); }
  a.runtime-link { color:var(--accent);text-decoration:none; } a.runtime-link:hover { text-decoration:underline; }
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
  .guidance { margin: 12px; padding: 12px 14px; border-radius: 7px; background: color-mix(in srgb, var(--accent) 8%, transparent); }
  .guidance p { margin: 4px 0; }.guidance .next { color: var(--accent); font-weight: 600; }
  .meaning { min-width: 18em; white-space: normal; }.next-action { color: var(--accent); white-space: normal; }
  .attention { margin: 12px; padding: 10px 12px; border-left: 3px solid var(--warn); background: color-mix(in srgb, var(--warn) 10%, transparent); }
  .attention.error { border-left-color: var(--bad); background: color-mix(in srgb, var(--bad) 10%, transparent); }
  .attention p { margin: 0 0 5px; }.attention p:last-child { margin-bottom: 0; }
  .timeline { list-style: none; margin: 0; padding: 12px 16px; display: grid; gap: 10px; }
  .timeline li { display: grid; grid-template-columns: 9em minmax(0,1fr) auto; gap: 10px; align-items: baseline; border-left: 2px solid var(--line); padding-left: 12px; }
  .timeline .event-state { color: var(--muted); }.timeline .event-time { color: var(--muted); font: 12px ui-monospace, monospace; }
  .timeline .event-message { grid-column: 2 / -1; color: var(--muted); }
  @media (max-width: 700px) { .timeline li { grid-template-columns: 1fr; gap: 3px; } .timeline .event-message { grid-column: auto; } }

  /* RhinoQ mineral console: one visual system with Task Center, tuned denser
     here because operators compare evidence rather than scan a consumer feed. */
  :root {
    --bg:#f3f6fb;--panel:#fff;--raised:#f8faff;--line:#d8e0ee;--line-strong:#bdc9dc;--ink:#101828;
    --muted:#667085;--accent:#2563eb;--accent-strong:#1d4ed8;--accent-soft:#eaf1ff;--warn:#a15c00;
    --warn-soft:#fff4dc;--bad:#b42318;--bad-soft:#feeceb;--shadow:0 18px 48px rgba(15,35,70,.10);--ui:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"SFMono-Regular",Consolas,"Liberation Mono",monospace;
  }
  @media (prefers-color-scheme:dark){:root{--bg:#080d16;--panel:#0f1726;--raised:#131d30;--line:#26344d;--line-strong:#354766;--ink:#f1f5fb;--muted:#94a3b8;--accent:#4f8cff;--accent-strong:#76a5ff;--accent-soft:#14264a;--warn:#f0b35a;--warn-soft:#362712;--bad:#ff8b85;--bad-soft:#3b1c21;--shadow:0 24px 64px rgba(0,0,0,.38)}}
  body{min-height:100vh;background:radial-gradient(circle at 50% -18%,color-mix(in srgb,var(--accent) 9%,transparent),transparent 38%),var(--bg);font-family:var(--ui);letter-spacing:.002em}
  body>header{position:sticky;top:0;z-index:20;padding:11px max(20px,calc((100vw - 1240px)/2));align-items:center;background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(18px);border-color:var(--line);box-shadow:0 1px 0 rgba(0,0,0,.12)}
  body>header h1 a{font-size:17px;font-weight:780;letter-spacing:-.035em}
  body>header nav{gap:3px;padding:3px;border:1px solid var(--line);border-radius:9px;background:var(--panel)}
  body>header nav a{padding:6px 10px;color:var(--muted)}body>header nav a:hover{border-radius:6px;background:var(--raised);color:var(--ink);text-decoration:none}
  body>header nav strong{padding:6px 11px;border-radius:6px;background:var(--accent-soft);color:var(--accent-strong);box-shadow:inset 0 -2px 0 var(--accent)}
  main{max-width:1240px;width:100%;margin:0 auto;padding:28px 24px 64px;gap:18px}
  .workspace-intro{display:flex;justify-content:space-between;align-items:end;gap:24px;padding:22px 24px;border:1px solid var(--line);border-radius:14px;background:linear-gradient(135deg,var(--panel),color-mix(in srgb,var(--accent-soft) 55%,var(--panel)));box-shadow:var(--shadow)}
  .workspace-intro .eyebrow{margin:0 0 5px;color:var(--accent-strong);font:700 11px/1.4 var(--mono);letter-spacing:.1em;text-transform:uppercase}
  .workspace-intro h2{margin:0;font-size:clamp(25px,3vw,36px);line-height:1.12;letter-spacing:-.045em}
  .workspace-intro p:last-child{max-width:560px;margin:8px 0 0;color:var(--muted);font-size:14px}
  .panel{border-color:var(--line);border-radius:12px;background:linear-gradient(180deg,var(--panel),color-mix(in srgb,var(--raised) 70%,var(--panel)));box-shadow:0 10px 30px rgba(15,35,70,.055)}
  .head{min-height:48px;padding:12px 16px;background:var(--raised);border-color:var(--line)}
  .head strong{font-size:14px;letter-spacing:-.01em}.head .muted{font-size:12px}
  .buckets{display:grid;grid-template-columns:repeat(7,minmax(110px,1fr));gap:8px}
  .bucket{position:relative;min-width:0;padding:14px 15px;border-color:var(--line);border-radius:10px;background:linear-gradient(180deg,var(--panel),var(--raised));transition:transform .15s ease,border-color .15s ease,box-shadow .15s ease}
  .bucket:hover{transform:translateY(-1px);border-color:color-mix(in srgb,var(--accent) 45%,var(--line));box-shadow:0 8px 18px rgba(25,50,40,.06)}
  .bucket[aria-pressed="true"]{border-color:var(--accent);background:var(--accent-soft);box-shadow:inset 0 -2px 0 var(--accent),0 8px 22px color-mix(in srgb,var(--accent) 12%,transparent)}
  .bucket b{font-size:24px;letter-spacing:-.04em}.bucket span{font-size:12px;text-transform:capitalize}
  .runtime-grid{gap:12px;padding:14px}.runtime-card{border-color:var(--line);border-radius:10px;padding:15px;background:var(--raised);box-shadow:0 6px 18px rgba(15,35,70,.045)}
  .runtime-card .top>span{font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:.06em}
  .runtime-counts{gap:8px}.runtime-counts span{padding:7px 8px;border-radius:7px;background:var(--bg)}
  th,td{padding:11px 14px}th{background:color-mix(in srgb,var(--bg) 70%,transparent);font:700 10px/1.4 var(--mono);letter-spacing:.09em}td code,.event-time{font-family:var(--mono)}
  tbody tr[data-id]{transition:background .12s ease}tbody tr[data-id]:hover{background:var(--accent-soft)}
  code{padding:2px 5px;border-radius:4px;background:color-mix(in srgb,var(--bg) 75%,transparent)}
  .guidance{margin:14px;padding:15px 16px;border:1px solid color-mix(in srgb,var(--accent) 22%,transparent);border-radius:9px;background:var(--accent-soft)}
  .attention{border-radius:0 8px 8px 0;background:var(--warn-soft)}.attention.error{background:var(--bad-soft)}
  .timeline{padding:16px 20px;gap:14px}.timeline li{border-left-color:color-mix(in srgb,var(--accent) 42%,var(--line));padding-left:15px}
  button:focus-visible,a:focus-visible,[data-id]:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 38%,transparent);outline-offset:2px}
  @media(max-width:980px){.buckets{grid-template-columns:repeat(4,1fr)}}
  @media(max-width:700px){body>header{padding:11px 14px}.workspace-intro{align-items:start;flex-direction:column}.buckets{display:flex;overflow-x:auto;flex-wrap:nowrap;padding-bottom:4px}.bucket{min-width:116px}main{padding:20px 12px 48px}.head{align-items:flex-start;flex-wrap:wrap}.runtime-grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<header>
  <h1><a href="__RHINOQ_HOME__">RhinoQ</a></h1>
  <nav aria-label="Product">__RHINOQ_NAV__<strong aria-current="page">Workbench</strong></nav>
  <span class="muted" id="mode"></span>
  <span class="live muted" id="live" data-state="connecting" style="margin-left:auto">
    <span class="dot"></span><span id="liveText">connecting…</span>
  </span>
</header>
<div class="err" id="err" hidden></div>
<main>
  <section class="workspace-intro" aria-labelledby="workbenchTitle">
    <div><p class="eyebrow">Operator workspace</p><h2 id="workbenchTitle">Async work, explained.</h2><p>Find what needs attention, follow every attempt, and move from runtime evidence to a safe next action.</p></div>
  </section>
  <section class="panel" id="runtimePanel" hidden>
    <div class="head"><strong>Runtime health</strong><span class="muted">read-only evidence from the connected job runtime</span></div>
    <div class="runtime-grid" id="runtimeHealth"></div>
  </section>
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
    <div class="guidance" id="guidance">
      <strong id="guidanceHeadline">What this means</strong>
      <p id="guidanceExplanation"></p>
      <p class="muted" id="guidanceProgress"></p>
      <p class="next" id="guidanceNext"></p>
    </div>
    <div class="scroll"><table id="detail"><tbody></tbody></table></div>
  </div>
  <div class="panel" id="flightPanel" hidden>
    <div class="head"><strong>Async Flight Recorder</strong><span class="muted" id="flightExplanation"></span></div>
    <div id="attention" aria-live="polite"></div>
    <ol class="timeline" id="timeline"></ol>
  </div>
  <div class="panel" id="incidentPanel" hidden>
    <div class="head"><strong>Incident Explainer</strong><span class="muted" id="incidentOutcome"></span></div>
    <div class="guidance">
      <strong id="incidentSummary"></strong>
      <p id="incidentTechnical"></p>
      <p class="muted" id="incidentAffected"></p>
      <div id="incidentEvidence"></div>
      <p class="next" id="incidentActions"></p>
    </div>
  </div>
</main>
<script>
const base = location.pathname.replace(/\/+$/, '');
let snap = null;          // last payload the server sent
let active = 'attention';
let currentId = new URLSearchParams(location.search).get('task');
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
  $('buckets').innerHTML = Array.from({ length: 7 }, () =>
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

function renderRuntimeHealth() {
  const runtimeScopes = snap?.runtimeHealth || [];
  $('runtimePanel').hidden = runtimeScopes.length === 0;
  $('runtimeHealth').innerHTML = runtimeScopes.map((scope) => {
    const reason = scope.reason === 'waiting_without_workers' ? 'Work is waiting but no worker is connected.' : scope.reason === 'worker_visibility_unavailable' ? 'Worker visibility is unavailable; health is not assumed.' : scope.reason === 'runtime_unreachable' ? 'The queue could not be inspected.' : 'Queue inspection succeeded.';
    const workers = scope.workers.observable ? String(scope.workers.connected ?? 0) : 'unknown';
    const title = scope.dashboardURL ? '<a class="runtime-link" href="' + esc(scope.dashboardURL) + '">' + esc(scope.scope) + ' ↗</a>' : '<strong>' + esc(scope.scope) + '</strong>';
    return '<article class="runtime-card"><div class="top">' + title + '<span class="health-' + esc(scope.status) + '">' + esc(scope.status) + '</span></div><div class="runtime-counts"><span><b>' + scope.queue.waiting + '</b>waiting</span><span><b>' + scope.queue.active + '</b>active</span><span><b>' + workers + '</b>workers</span><span><b>' + scope.queue.delayed + '</b>delayed</span><span><b>' + scope.queue.failed + '</b>failed</span><span><b>' + (scope.queue.paused ? 'yes' : 'no') + '</b>paused</span></div><span class="muted">' + esc(reason) + '</span></article>';
  }).join('');
}

function renderList() {
  const tasks = (snap.lists && snap.lists[active]) || [];
  $('listTitle').textContent = 'Tasks · ' + active;
  $('listNote').textContent = tasks.length ? tasks.length + ' shown' : '';
  const body = $('list').querySelector('tbody');
  if (!tasks.length) {
    previousRows = new Map();
    const empty = active === 'attention'
      ? 'Nothing needs attention. Tasks with an unclear outcome or a failed attempt will appear here.'
      : 'No tasks are currently ' + active.replaceAll('_', ' ') + '.';
    body.innerHTML = '<tr><td class="empty">' + esc(empty) + '</td></tr>';
    return;
  }
  const next = new Map();
  body.innerHTML = '<tr><th>Task</th><th>Type</th><th>What this means</th><th>Next action</th><th>Items</th><th>Idle</th></tr>' +
    tasks.map((task) => {
      const counts = task.itemCounts || task.executionCounts || {};
      const done = (counts.succeeded ?? 0) + (counts.failed ?? 0) + (counts.cancelled ?? 0);
      const explanation = task.ui?.explanation || {};
      const signature = task.entityVersion + ':' + task.state + ':' + done;
      const changed = previousRows.has(task.id) && previousRows.get(task.id) !== signature;
      next.set(task.id, signature);
      return '<tr data-id="' + esc(task.id) + '"' + (changed ? ' class="changed"' : '') +
        '><td><code>' + esc(task.id) + '</code></td><td>' + esc(task.type) + '</td><td class="meaning"><strong>' +
        esc(explanation.headline || task.state) + '</strong><br><span class="muted">' +
        esc(explanation.explanation || '') + '</span></td><td class="next-action">' +
        esc(explanation.recommendedAction?.label || 'Review task details') + '</td><td>' +
        done + ' / ' + (counts.total ?? 0) +
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
  const explanation = detail.ui?.explanation;
  $('guidanceHeadline').textContent = explanation?.headline || 'What this means';
  $('guidanceExplanation').textContent = explanation?.explanation || 'Review the recorded task details.';
  $('guidanceProgress').textContent = explanation?.progressText || '';
  $('guidanceNext').textContent = 'Next action: ' + (explanation?.recommendedAction?.label || 'Review task details');
  const cancellable = ['pending', 'queued', 'running'].includes(detail.task.state);
  const cancelAction = detail.incidentExplanation?.recommendedActions?.find((action) => action.id === 'request-cancellation');
  $('cancelBtn').hidden = !(snap.actions && cancellable && (!cancelAction || cancelAction.availability === 'available'));
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
        esc(item.state) + '</td><td>' + (item.runtimeURL ? '<a class="runtime-link" href="' + esc(item.runtimeURL) + '"><code>' + esc(item.externalId) + '</code> ↗</a>' : '<code class="muted">' + esc(item.externalId ?? '—') + '</code>') +
        '</td><td>' + esc(item.failureReason ?? (item.hasResult ? 'result recorded' : '')) +
        '</td></tr>';
    }).join('');
  previousItems = next;
  renderIncident(detail.incidentExplanation);
  renderFlightRecorder(detail.flightRecorder);
}

function renderIncident(incident) {
  if (!incident) { $('incidentPanel').hidden = true; return; }
  $('incidentPanel').hidden = false;
  $('incidentOutcome').textContent = 'business outcome: ' + incident.businessOutcome;
  $('incidentSummary').textContent = incident.summary;
  $('incidentTechnical').textContent = incident.technicalState;
  $('incidentAffected').textContent = 'Affected: ' + incident.affected.tasks + ' task(s), ' + incident.affected.items + ' item(s)' + (incident.affected.owners ? ', ' + incident.affected.owners + ' owner(s)' : '');
  $('incidentEvidence').innerHTML = (incident.evidence || []).map((item) => '<p><strong>' + esc(item.kind) + ':</strong> ' + esc(item.statement) + '</p>').join('');
  $('incidentActions').textContent = 'Next actions: ' + (incident.recommendedActions || []).map((action) => {
    if (action.id === 'request-cancellation' && action.availability === 'available') {
      return action.label + (snap.actions ? ' [available here]' : ' [not configured: enable Workbench actions]');
    }
    if (action.id === 'inspect-runtime' && action.availability === 'available') {
      return action.label + ($('detail').querySelector('.runtime-link') ? ' [open external tool]' : ' [not configured: add runtimeJobLink]');
    }
    if (action.id === 'recheck-evidence' && action.availability === 'available') {
      return action.label + ' [not configured: register a verifier/recheck workflow]';
    }
    return action.label + ' [' + action.availability + ': ' + action.reason + ']';
  }).join(' · ');
}

function renderFlightRecorder(recorder) {
  if (!recorder) { $('flightPanel').hidden = true; return; }
  $('flightPanel').hidden = false;
  $('flightExplanation').textContent = recorder.explanation || '';
  $('attention').innerHTML = (recorder.attention || []).map((item) =>
    '<div class="attention ' + (item.severity === 'error' ? 'error' : '') + '"><p><strong>' +
    esc(item.kind) + '</strong></p><p>' + esc(item.message) + '</p></div>').join('');
  const events = recorder.events || [];
  $('timeline').innerHTML = events.length ? events.map((event) =>
    '<li><span class="event-time">' + esc(new Date(event.observedAt).toLocaleString()) +
    '</span><strong>' + esc(event.label) + '</strong><span class="event-state">' +
    esc(event.state || '') + '</span>' + (event.message ? '<span class="event-message">' +
    esc(event.message) + '</span>' : '') + '</li>').join('') :
    '<li><span class="muted">No recorded events.</span></li>';
}

function render() {
  if (!snap) return;
  renderBuckets();
  renderRuntimeHealth();
  renderList();
  renderDetail();
  $('err').hidden = true;
}

function select(taskId) {
  if (currentId === taskId) return;
  currentId = taskId;
  history.pushState({ taskId }, '', base + '?task=' + encodeURIComponent(taskId));
  previousItems = new Map();
  $('detailPanel').hidden = false;
  $('flightPanel').hidden = true;
  $('incidentPanel').hidden = true;
  $('timeline').replaceChildren();
  $('detail').querySelector('tbody').innerHTML =
    '<tr><td><span class="skel w-lg"></span></td><td><span class="skel"></span></td><td><span class="skel"></span></td></tr>';
  connect();   // re-subscribe so the server streams this Task too
}

addEventListener('popstate', () => {
  currentId = new URLSearchParams(location.search).get('task');
  previousItems = new Map();
  if (!currentId) {
    $('detailPanel').hidden = true;
    $('flightPanel').hidden = true;
    $('incidentPanel').hidden = true;
    connect();
    return;
  }
  connect();
});

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

export function workbenchPage(
  navigation: { overviewPath?: string; tasksPath?: string } = {},
): string {
  const home = escapeAttribute(navigation.overviewPath ?? navigation.tasksPath ?? '#');
  const links = [
    navigation.overviewPath ? `<a href="${escapeAttribute(navigation.overviewPath)}">Overview</a>` : '',
    navigation.tasksPath ? `<a href="${escapeAttribute(navigation.tasksPath)}">Tasks</a>` : '',
  ].join('');
  return WORKBENCH_PAGE
    .replace('__RHINOQ_HOME__', home)
    .replace('__RHINOQ_NAV__', links);
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}
