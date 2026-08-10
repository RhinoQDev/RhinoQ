// One page, no build step. It polls the same owner-scoped Task API your own
// frontend would call — there is no privileged endpoint behind this.
export const page = () => `<!doctype html>
<meta charset="utf-8">
<title>RhinoQ</title>
<style>
  :root { color-scheme: light dark; --line: color-mix(in srgb, currentColor 15%, transparent); }
  body { font: 15px/1.55 system-ui, sans-serif; max-width: 68rem; margin: 0 auto 3rem; padding: 0 1.25rem; }
  .shell { display:flex;align-items:center;gap:1.25rem;padding:.9rem 0;border-bottom:1px solid var(--line);margin-bottom:2rem; }
  .shell strong { margin-right:auto; }.shell a { color:inherit;text-decoration:none; }.shell a[aria-current] { font-weight:700;text-decoration:underline;text-underline-offset:.3rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  p.sub { margin: 0 0 2rem; opacity: .7; }
  button, .button { font: inherit; padding: .45rem .9rem; border: 1px solid var(--line); border-radius: .4rem;
           background: transparent; color: inherit; cursor: pointer; text-decoration: none; }
  button:hover:not(:disabled), .button:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
  button:disabled { opacity: .4; cursor: default; }
  .row { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; margin-bottom: 1.25rem; }
  .bar { height: .55rem; border-radius: .3rem; background: var(--line); overflow: hidden; margin: .6rem 0; }
  .bar > i { display: block; height: 100%; width: 0; background: currentColor; transition: width .2s; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: .15rem 1rem; margin: 0 0 1.25rem; }
  dt { opacity: .6; } dd { margin: 0; font-variant-numeric: tabular-nums; }
  .card { border: 1px solid var(--line); border-radius: .6rem; padding: 1rem 1.25rem; margin-bottom: 1.5rem; }
  .finding { border-color: #d97706; }
  .value { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: .75rem; }
  .value div { border-left: 3px solid currentColor; padding-left: .75rem; }
  .value strong { display: block; }
  .overview { display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:.75rem;margin:1rem 0 1.5rem; }
  .metric { border:1px solid var(--line);border-radius:.6rem;padding:.8rem 1rem; }.metric b { display:block;font-size:1.6rem; }.metric span { opacity:.7; }
  .attention-item { display:grid;grid-template-columns:minmax(10rem,1fr) minmax(14rem,2fr) auto;gap:.75rem;padding:.75rem 0;border-bottom:1px solid var(--line);align-items:center; }
  .attention-item:last-child { border-bottom:0; }.attention-item p { margin:0;opacity:.75; }.attention-item a { color:inherit;white-space:nowrap; }
  code { font-size: .9em; }
  pre { white-space: pre-wrap; margin: .5rem 0 0; font-size: .85rem; opacity: .85; }
  @media (max-width: 620px) { .shell { align-items:flex-start;flex-wrap:wrap; }.shell strong { width:100%; }.attention-item { grid-template-columns:1fr; }.attention-item a { white-space:normal; } }
</style>

<header class="shell"><strong><a href="/">RhinoQ</a></strong><a href="/" aria-current="page">Overview</a><a href="/task-center">Tasks</a><a href="/operator-login">Workbench</a></header>

<h1>Async operations overview</h1>
<p class="sub">RhinoQ makes background work visible and actionable: users get
progress and results, developers get one Task contract, and operators get the
context to understand failures and recover safely.</p>

<section class="overview" aria-label="Task overview">
  <div class="metric"><b id="attentionCount">0</b><span>Needs attention</span></div>
  <div class="metric"><b id="riskCount">0</b><span>At risk / stuck</span></div>
  <div class="metric"><b id="waitingCount">0</b><span>Waiting for me</span></div>
  <div class="metric"><b id="runningCount">0</b><span>In progress</span></div>
  <div class="metric"><b id="completedCount">0</b><span>Completed</span></div>
  <div class="metric"><b id="verifiedCount">0</b><span>Recently verified</span></div>
  <div class="metric"><b id="recentCount">0</b><span>Recent tasks</span></div>
</section>

<section class="card">
  <strong>Waiting for me</strong>
  <p class="sub" style="margin:.35rem 0 .5rem">Durable input and approval requests appear here; external webhooks stay out of your action list.</p>
  <div id="waitingList"><p>No tasks are waiting for you.</p></div>
</section>

<section class="card">
  <strong>Needs attention</strong>
  <p class="sub" style="margin:.35rem 0 .5rem">Failed, uncertain or partially completed work appears here with the safest next step.</p>
  <div id="attentionList"><p>No tasks need attention.</p></div>
</section>

<div class="row">
  <button id="start">Start a 50-item batch</button>
  <button id="cancel" disabled>Cancel</button>
  <a class="button" href="/task-center">Task Center</a>
  <a class="button" href="/operator-login">Operator Workbench →</a>
</div>

<div class="card">
  <strong>What RhinoQ replaced in this example</strong>
  <p class="sub" style="margin:.4rem 0 1rem">The integration surface is three objects
  you already have, one middleware, and one dispatch call.</p>
  <div class="value">
    <div><strong>Task lifecycle</strong>Durable state, per-item attempts and aggregate progress.</div>
    <div><strong>Recovery</strong>Projector fencing, reconciliation and explicit uncertain outcomes.</div>
    <div><strong>Product surfaces</strong>Owner API + Task Center, and a protected operator Workbench.</div>
  </div>
</div>

<div class="card">
  <strong id="taskId">no batch yet</strong>
  <div class="bar"><i id="fill"></i></div>
  <dl>
    <dt>state</dt><dd id="state">—</dd>
    <dt>items</dt><dd id="items">—</dd>
    <dt>attempts</dt><dd id="attempts">—</dd>
    <dt>cancellation</dt><dd id="cancellation">—</dd>
  </dl>
</div>

<div class="card" id="drift">
  <strong>Did the work actually happen?</strong>
  <p class="sub" style="margin:.4rem 0 1rem">Each job writes an output file. This deletes one that the
  queue reported as <code>completed</code> — BullMQ still says the job succeeded and still has the
  return value. Then check the storage itself.</p>
  <div class="row" style="margin:0">
    <button id="break" disabled>Delete one finished output</button>
    <button id="verify" disabled>Verify storage</button>
  </div>
  <pre id="report"></pre>
</div>

<script>
const $ = (id) => document.getElementById(id);
const headers = { 'content-type': 'application/json', 'x-user': 'demo-user' };
let taskId = null;
let snapshot = null;
let lastListAt = 0;

async function api(path, options = {}) {
  const response = await fetch(path, { headers, ...options });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

$('start').onclick = async () => {
  $('start').disabled = true;
  const created = await api('/batches', { method: 'POST', body: JSON.stringify({ size: 50 }) });
  taskId = created.taskId;
  $('report').textContent = '';
  $('start').disabled = false;
};

$('cancel').onclick = async () => {
  if (!snapshot) return;
  $('cancel').disabled = true;
  // /cancel stops the jobs as well as recording the intent. The browser-safe
  // /tasks/:id/cancel records intent only and never touches Redis; either is
  // fine, and neither needs an expectedVersion — a fan-out advances the Task
  // version several times a second, so a version this page read is already old
  // by the time the request lands.
  const result = await api('/cancel/' + taskId, { method: 'POST' });
  if (result.cancellation?.reason) $('report').textContent = result.cancellation.reason;
};

$('break').onclick = async () => {
  const result = await api('/break/' + taskId, { method: 'POST' });
  $('report').textContent = 'Deleted the output of ' + result.deleted +
    '. BullMQ still reports that job completed. Now press Verify storage.';
};

$('verify').onclick = async () => {
  $('verify').disabled = true;
  const result = await api('/verify/' + taskId, { method: 'POST' });
  $('drift').classList.toggle('finding', result.findings.length > 0);
  $('report').textContent = result.findings.length === 0
    ? 'Checked ' + result.checked + ' finished items. Every output is where it should be.'
    : 'Checked ' + result.checked + ' finished items. ' + result.findings.length +
      ' finished but the output is gone:\\n' +
      result.findings.map((f) => '  ' + f.item + ': ' + f.status).join('\\n');
  $('verify').disabled = false;
};

async function poll() {
  try {
    if (Date.now() - lastListAt > 2000) {
      const [list, waits, risks, verified] = await Promise.all([
        api('/tasks?limit=50'),
        api('/tasks/_waitpoints?limit=50'),
        api('/tasks/_risk?limit=50'),
        api('/tasks/_verified?limit=20'),
      ]);
      renderOverview(list.tasks || [], waits.waitpoints || [], risks.tasks || []);
      $('verifiedCount').textContent = (verified.verifications || []).length;
      if (!taskId) taskId = list.tasks[0]?.id ?? null;
      lastListAt = Date.now();
    }
    if (taskId) {
      snapshot = await api('/tasks/' + taskId + '/summary');
      render(snapshot);
    }
  } catch { /* the server is restarting; the next tick will pick it up */ }
  setTimeout(poll, 400);
}

function renderOverview(tasks, waitpoints, riskTasks) {
  const riskById = new Map(riskTasks.map((task) => [task.id, task]));
  const attentionTasks = tasks.filter((task) => {
    const counts = task.itemCounts ?? task.executionCounts ?? {};
    return task.state === 'failed' || task.state === 'uncertain' ||
      task.cancellation?.status === 'too_late' ||
      task.cancellation?.status === 'cannot_cancel_safely' ||
      ((counts.failed ?? 0) > 0 && (counts.succeeded ?? 0) > 0) || riskById.has(task.id);
  }).map((task) => ({ ...task, derivedRisk: riskById.get(task.id) }));
  const inProgress = tasks.filter((task) =>
    ['pending', 'queued', 'running', 'cancel_requested'].includes(task.state)).length;
  const waitingForMe = waitpoints.filter((waitpoint) =>
    waitpoint.kind === 'approval' || waitpoint.kind === 'input');
  $('attentionCount').textContent = attentionTasks.length;
  $('riskCount').textContent = riskTasks.length;
  $('waitingCount').textContent = waitingForMe.length;
  $('runningCount').textContent = inProgress;
  $('completedCount').textContent = tasks.filter((task) => task.state === 'succeeded').length;
  $('recentCount').textContent = tasks.length;
  renderWaiting(waitingForMe, tasks);
  const attentionList = $('attentionList');
  if (!attentionTasks.length) {
    const empty = document.createElement('p');
    empty.textContent = 'Nothing needs attention. Failed, uncertain or partial work will appear here.';
    attentionList.replaceChildren(empty);
    return;
  }
  attentionList.replaceChildren(...attentionTasks.slice(0, 5).map((task) => {
    const guidance = overviewGuidance(task);
    const row = document.createElement('div');
    row.className = 'attention-item';
    const identity = document.createElement('strong');
    identity.textContent = task.type + ' · ' + task.id;
    const meaning = document.createElement('p');
    meaning.textContent = guidance[0] + ' Next: ' + guidance[1];
    const link = document.createElement('a');
    link.href = '/task-center/' + encodeURIComponent(task.id);
    link.textContent = 'View task →';
    row.append(identity, meaning, link);
    return row;
  }));
}

function renderWaiting(waitpoints, tasks) {
  const waitingList = $('waitingList');
  if (!waitpoints.length) {
    const empty = document.createElement('p');
    empty.textContent = 'Nothing is waiting for your input or approval.';
    waitingList.replaceChildren(empty);
    return;
  }
  const taskNames = new Map(tasks.map((task) => [task.id, task.type]));
  waitingList.replaceChildren(...waitpoints.slice(0, 5).map((waitpoint) => {
    const row = document.createElement('div');
    row.className = 'attention-item';
    const identity = document.createElement('strong');
    identity.textContent = (taskNames.get(waitpoint.taskId) || 'Task') + ' · ' + waitpoint.key;
    const meaning = document.createElement('p');
    meaning.textContent = waitpoint.kind === 'approval'
      ? 'A decision is required before this work can continue.'
      : 'The application needs more information before this work can continue.';
    const link = document.createElement('a');
    link.href = '/task-center/' + encodeURIComponent(waitpoint.taskId);
    link.textContent = waitpoint.kind === 'approval' ? 'Review approval →' : 'View request →';
    row.append(identity, meaning, link);
    return row;
  }));
}

function overviewGuidance(task) {
  const counts = task.itemCounts ?? task.executionCounts ?? {};
  if (task.derivedRisk?.risk === 'stuck') return ['No progress has been recorded past the stuck threshold.', 'Check the worker and dependency before retrying.'];
  if (task.derivedRisk?.risk === 'at_risk') return ['This task has stopped reporting progress.', 'Check the worker before it becomes stuck.'];
  if (task.cancellation?.status === 'cannot_cancel_safely') return ['This work could not be stopped safely.', 'Review completed work.'];
  if (task.cancellation?.status === 'too_late') return ['The work finished before cancellation.', 'Review the result.'];
  if (task.state === 'uncertain') return ['The external result still needs confirmation.', 'Check confirmation before repeating it.'];
  if ((counts.failed ?? 0) > 0 && (counts.succeeded ?? 0) > 0) return [(counts.failed ?? 0) + ' item(s) need attention.', 'Review failed items.'];
  return ['The task did not finish.', 'Review the failed attempt before retrying.'];
}

function render(task) {
  const items = task.itemCounts ?? task.executionCounts;
  const done = items.succeeded + items.failed + items.cancelled;
  $('taskId').textContent = task.id;
  $('fill').style.width = (items.total ? (done / items.total) * 100 : 0) + '%';
  $('state').textContent = task.state;
  // itemCounts, not executionCounts: a retried item is one item, not two.
  $('items').textContent = done + ' / ' + items.total +
    ' (' + items.succeeded + ' ok, ' + items.failed + ' failed)';
  $('attempts').textContent = task.executionCounts.total +
    (items.retries ? ' (' + items.retries + ' retried)' : '');
  $('cancellation').textContent = task.cancellation?.status ?? 'none';
  const running = task.state === 'running' || task.state === 'queued';
  $('cancel').disabled = !running;
  $('break').disabled = items.succeeded === 0;
  $('verify').disabled = items.succeeded === 0;
}

poll();
</script>
`;

export const operatorLoginPage = (invalid = false) => `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RhinoQ operator sign in</title>
<style>
  :root { color-scheme: light dark; --line: color-mix(in srgb, currentColor 18%, transparent); }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 25rem; margin: 12vh auto; padding: 0 1.25rem; }
  form { border: 1px solid var(--line); border-radius: .7rem; padding: 1.25rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .35rem; }
  p { opacity: .72; }
  label { display: block; margin: 1rem 0 .35rem; }
  input, button { box-sizing: border-box; width: 100%; font: inherit; padding: .6rem .75rem; border-radius: .4rem; }
  input { border: 1px solid var(--line); }
  button { margin-top: .75rem; border: 0; background: #2563eb; color: white; cursor: pointer; }
  .error { color: #dc2626; opacity: 1; }
  nav { display:flex;gap:1rem;margin-bottom:1rem; } nav a { color:inherit; }
</style>
<nav aria-label="Product"><a href="/">Overview</a><a href="/task-center">Tasks</a></nav>
<form method="post" action="/operator-login">
  <h1>RhinoQ operator sign in</h1>
  <p>This local evaluation keeps cross-owner task data behind the operator token.</p>
  ${invalid ? '<p class="error">That token is not valid.</p>' : ''}
  <label for="token">Operator token</label>
  <input id="token" name="token" type="password" autocomplete="current-password" required autofocus>
  <button type="submit">Open Workbench</button>
</form>`;
