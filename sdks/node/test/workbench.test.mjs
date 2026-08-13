// The Workbench reads across owners and shows runtime job identity — the two
// things the owner-scoped API withholds. Everything here is about the gate in
// front of that, and about the page being self-contained.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkbenchHandler } from '../dist/index.js';

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    entityVersion: 4,
    id: 'task-1',
    type: 'bulk-download',
    ownerId: 'owner-a',
    state: 'running',
    cancellation: { status: 'none' },
    progress: { completed: 1, total: 2 },
    hasResult: false,
    executions: [
      { id: 'task-1:a', itemKey: 'item-a', attempt: 1, runtime: 'bullmq', state: 'running', version: 2, hasResult: false },
      { id: 'task-1:b', itemKey: 'item-b', attempt: 1, runtime: 'bullmq', state: 'failed', version: 3, hasResult: false, failureReason: 'source returned 404' },
    ],
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:01:00.000Z',
    ...overrides,
  };
}

function source(recorder = {}) {
  return {
    async listTasksByState(query) {
      recorder.queries = recorder.queries ?? [];
      recorder.queries.push(query);
      return query.states[0] === 'running'
        ? [{ ...snapshot(), executionCounts: { total: 2, succeeded: 0, failed: 1, running: 1, pendingDispatch: 0, dispatched: 0, stalled: 0, cancelled: 0 } }]
        : [];
    },
    async getTask() { return snapshot(); },
    async getTaskExecutionResults(taskId) {
      return { schemaVersion: 1, entityVersion: 4, taskId, executions: [] };
    },
    async listTaskExecutionRuntimeRefs(taskId) {
      return {
        schemaVersion: 1,
        entityVersion: 4,
        taskId,
        executions: [
          { executionId: 'task-1:a', itemKey: 'item-a', attempt: 1, runtime: 'bullmq', externalId: 'bull-job-a', state: 'running' },
        ],
      };
    },
    async listTaskWaitpoints() { return []; },
    async requestTaskCancellation(taskId, expectedVersion) {
      recorder.cancelled = { taskId, expectedVersion };
      return snapshot({ state: 'cancel_requested', cancellation: { status: 'requested' } });
    },
  };
}

const get = (handler, path) => handler(new Request(`http://app.test${path}`));

test('mounting without an operator gate is refused at construction', () => {
  assert.throws(
    () => createWorkbenchHandler({ tasks: source() }),
    /requireOperator/,
  );
});

test('a request that fails the operator gate sees no data at all', async () => {
  const handler = createWorkbenchHandler({ tasks: source(), requireOperator: () => false });
  for (const path of ['/rhinoq', '/rhinoq/api/overview', '/rhinoq/api/runtime-health', '/rhinoq/api/tasks', '/rhinoq/api/tasks/task-1', '/rhinoq/api/tasks/task-1/flight-recorder', '/rhinoq/api/tasks/task-1/incident-explanation']) {
    const response = await get(handler, path);
    const body = await response.text();
    assert.equal(response.status, 403, path);
    assert.ok(!body.includes('bull-job-a') && !body.includes('owner-a'), `${path} leaked: ${body}`);
  }
});

test('a requireOperator that throws is a refusal, not a crash', async () => {
  const handler = createWorkbenchHandler({
    tasks: source(),
    requireOperator: () => { throw new Error('auth backend down'); },
  });
  const response = await get(handler, '/rhinoq/api/overview');
  assert.equal(response.status, 403);
  assert.ok(!(await response.text()).includes('auth backend down'), 'the reason must not leak');
});

test('the page is self-contained: no external origin is referenced', async () => {
  const handler = createWorkbenchHandler({ tasks: source(), requireOperator: () => true, navigation: { overviewPath: '/', tasksPath: '/task-center' } });
  const response = await get(handler, '/rhinoq');
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  // An operator console that cannot load offline is worse than none.
  assert.ok(!/https?:\/\/(?!app\.test)/.test(html), 'the page must not fetch from another origin');
  assert.ok(!html.includes('<script src'), 'no external script tags');
  assert.match(html, /Async Flight Recorder/);
  assert.match(html, /Incident Explainer/);
  assert.match(html, /Runtime health/);
  assert.match(html, /Operator workspace/);
  assert.match(html, /Async work, explained/);
  assert.match(html, /workspace-intro/);
  assert.match(html, /--accent-strong/);
  assert.match(html, /--mono/);
  assert.match(html, /#4f8cff/);
  assert.match(html, /focus-visible/);
  assert.match(html, /snap\?\.runtimeHealth/);
  assert.ok(!html.includes("fetch(base + '/api/runtime-health'"), 'runtime health must share the Workbench snapshot');
  assert.match(html, /flightPanel/);
  assert.match(html, /let active = 'attention'/);
  assert.match(html, /What this means/);
  assert.match(html, /Next action/);
  assert.match(html, /Nothing needs attention/);
  assert.match(html, /href="\/"/);
  assert.match(html, /href="\/task-center"/);
  assert.match(html, /history\.pushState/);
  assert.match(html, /addEventListener\('popstate'/);
});

test('runtime health is operator-only, bounded and strips unsafe dashboard URLs', async () => {
  let calls = 0;
  const readers = Array.from({ length: 55 }, (_, index) => ({ async inspect() {
    calls += 1;
    return { schemaVersion: 1, runtime: 'bullmq', scope: `queue-${index}`, status: 'healthy', observedAt: new Date().toISOString(), queue: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 1, paused: false }, workers: { observable: true, connected: 1 }, dashboardURL: 'javascript:alert(1)' };
  } }));
  const handler = createWorkbenchHandler({ tasks: source(), requireOperator: () => true, runtimeHealth: readers });
  const body = await (await get(handler, '/rhinoq/api/runtime-health')).json();
  assert.equal(calls, 50);
  assert.equal(body.scopes.length, 50);
  assert.equal(body.scopes[0].dashboardURL, undefined);
  const overview = await (await get(handler, '/rhinoq/api/overview')).json();
  assert.equal(overview.runtimeHealth.length, 50);
});

test('runtime job links accept only relative and HTTP(S) destinations', async () => {
  const safe = createWorkbenchHandler({ tasks: source(), requireOperator: () => true, runtimeJobLink: ({ externalId }) => `/ops/jobs/${externalId}` });
  const safeBody = await (await get(safe, '/rhinoq/api/tasks/task-1')).json();
  assert.equal(safeBody.items[0].runtimeURL, '/ops/jobs/bull-job-a');

  const unsafe = createWorkbenchHandler({ tasks: source(), requireOperator: () => true, runtimeJobLink: () => 'javascript:alert(document.cookie)' });
  const unsafeBody = await (await get(unsafe, '/rhinoq/api/tasks/task-1')).json();
  assert.equal(unsafeBody.items[0].runtimeURL, undefined);
});

test('the detail view joins runtime job identity from the server-side read', async () => {
  const handler = createWorkbenchHandler({ tasks: source(), requireOperator: () => true });
  const body = await (await get(handler, '/rhinoq/api/tasks/task-1')).json();

  assert.deepEqual(
    body.items.map((item) => [item.itemKey, item.state, item.externalId ?? null]),
    [['item-a', 'running', 'bull-job-a'], ['item-b', 'failed', null]],
  );
  assert.equal(body.items[1].failureReason, 'source returned 404');
  assert.equal(body.flightRecorder.schemaVersion, 2);
  assert.match(body.flightRecorder.explanation, /progress|finished/i);
  assert.match(body.ui.explanation.headline, /attention|progress/i);
  assert.ok(body.ui.explanation.recommendedAction.label);
  assert.equal(body.incidentExplanation.schemaVersion, 1);
  assert.equal(body.incidentExplanation.taskId, 'task-1');
  assert.ok(body.incidentExplanation.evidence.length > 0);
});

test('Incident Explainer has a focused authorized endpoint', async () => {
  const handler = createWorkbenchHandler({ tasks: source(), requireOperator: () => true });
  const response = await get(handler, '/rhinoq/api/tasks/task-1/incident-explanation');
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.taskId, 'task-1');
  assert.equal(body.businessOutcome, 'unknown');
  assert.ok(Array.isArray(body.recommendedActions));
});

test('Workbench refuses cancellation when runtime capability says unsupported', async () => {
  const recorder = {};
  const tasks = source(recorder);
  const original = tasks.getTask;
  tasks.getTask = async () => {
    const value = await original();
    return { ...value, executions: value.executions.map((execution) => ({ ...execution, runtimeScope: 'reports' })) };
  };
  const handler = createWorkbenchHandler({
    tasks, requireOperator: () => true, actions: true,
    runtimeReports: async () => [{
      name: 'bullmq', scope: 'reports',
      capabilities: { events: 'push', dispatch: true, inspect: true, cancel: 'unsupported', progress: true, stableAttempts: false },
      health: { status: 'healthy', checkedAt: new Date().toISOString() }, guaranteeGaps: ['cancellation unsupported'],
    }],
  });
  const response = await handler(new Request('http://app.test/rhinoq/api/tasks/task-1/cancel', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: 4 }),
  }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'RHINOQ_UNSUPPORTED');
  assert.equal(recorder.cancelled, undefined);
});

test('the Flight Recorder has a focused endpoint for operator tooling', async () => {
  const handler = createWorkbenchHandler({ tasks: source(), requireOperator: () => true });
  const response = await get(handler, '/rhinoq/api/tasks/task-1/flight-recorder');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.taskId, 'task-1');
  assert.ok(Array.isArray(body.events));
  assert.ok(Array.isArray(body.attention));
});

test('the Flight Recorder exposes a bounded diagnostic download', async () => {
  const handler = createWorkbenchHandler({ tasks: source(), requireOperator: () => true });
  const response = await get(handler, '/rhinoq/api/tasks/task-1/flight-recorder/diagnostic');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /task-1-flight-recorder\.json/);
  const body = JSON.parse(await response.text());
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.recorder.schemaVersion, 2);
});

test('the Workbench exposes a bounded Needs attention bucket', async () => {
  const summary = {
    ...snapshot(),
    executionCounts: { total: 2, succeeded: 1, failed: 1, running: 0, pendingDispatch: 0, dispatched: 0, stalled: 0, cancelled: 0 },
  };
  const handler = createWorkbenchHandler({
    tasks: {
      ...source(),
      async listTasksByState(query) {
        return query.states.length === 8 ? [summary] : [];
      },
    },
    requireOperator: () => true,
  });
  const overview = await (await get(handler, '/rhinoq/api/overview')).json();
  assert.ok(overview.states.includes('attention'));
  assert.equal(overview.counts.attention, 1);
  const attention = await (await get(handler, '/rhinoq/api/tasks?state=attention')).json();
  assert.equal(attention.tasks[0].id, 'task-1');
  assert.match(attention.tasks[0].ui.explanation.headline, /attention/i);
});

test('a store without the runtime-ref read still renders, without job identity', async () => {
  const partial = source();
  delete partial.listTaskExecutionRuntimeRefs;
  const handler = createWorkbenchHandler({ tasks: partial, requireOperator: () => true });
  const body = await (await get(handler, '/rhinoq/api/tasks/task-1')).json();

  assert.equal(body.items.length, 2);
  assert.equal(body.items[0].externalId, undefined);
});

test('cancellation is refused until actions are turned on', async () => {
  const recorder = {};
  const handler = createWorkbenchHandler({ tasks: source(recorder), requireOperator: () => true });
  const response = await handler(new Request('http://app.test/rhinoq/api/tasks/task-1/cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: 4 }),
  }));

  assert.equal(response.status, 403);
  assert.equal(recorder.cancelled, undefined, 'the store must not be touched');
  assert.equal((await (await get(handler, '/rhinoq/api/overview')).json()).actions, false);
});

test('with actions on, cancellation carries the version fence', async () => {
  const recorder = {};
  const handler = createWorkbenchHandler({
    tasks: source(recorder), requireOperator: () => true, actions: true,
  });
  const ok = await handler(new Request('http://app.test/rhinoq/api/tasks/task-1/cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: 4 }),
  }));
  assert.equal(ok.status, 200);
  assert.deepEqual(recorder.cancelled, { taskId: 'task-1', expectedVersion: 4 });

  // A missing fence is a bug in the caller, not something to guess around.
  const unfenced = await handler(new Request('http://app.test/rhinoq/api/tasks/task-1/cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }));
  assert.equal(unfenced.status, 400);
});

test('an unknown state is refused rather than passed to the store', async () => {
  const recorder = {};
  const handler = createWorkbenchHandler({ tasks: source(recorder), requireOperator: () => true });
  const response = await get(handler, '/rhinoq/api/tasks?state=succeeded');

  assert.equal(response.status, 400);
  assert.deepEqual(recorder.queries ?? [], []);
});

test('paths outside the mount are 404, including near misses', async () => {
  const handler = createWorkbenchHandler({
    tasks: source(), requireOperator: () => true, basePath: '/admin/rhinoq',
  });
  for (const path of ['/rhinoq', '/admin', '/admin/rhinoqx', '/admin/rhinoq/api/nope']) {
    assert.equal((await get(handler, path)).status, 404, path);
  }
  assert.equal((await get(handler, '/admin/rhinoq')).status, 200);
});

// Realtime is the point: an operator watching a batch must see it move without
// reloading. The stream writes only on change, so an idle console costs a
// keep-alive comment rather than a re-render.
test('the stream pushes a change and stays quiet when nothing changed', async () => {
  let completed = 1;
  const handler = createWorkbenchHandler({
    requireOperator: () => true,
    streamIntervalMs: 20,
    tasks: {
      ...source(),
      async listTasksByState(query) {
        return query.states[0] === 'running'
          ? [{ ...snapshot({ entityVersion: completed }), progress: { completed, total: 2 }, executionCounts: { total: 2, succeeded: completed, failed: 0, running: 1, pendingDispatch: 0, dispatched: 0, stalled: 0, cancelled: 0 } }]
          : [];
      },
    },
  });

  // The stream's poll timer is unref'd on purpose: an operator console must
  // never be the reason a process refuses to exit. In a server the client
  // socket holds the loop open; here nothing does, so the test must.
  const keepAlive = setInterval(() => {}, 25);

  const controller = new AbortController();
  const response = await handler(new Request('http://app.test/rhinoq/api/stream', { signal: controller.signal }));
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const readUntil = async (predicate, budget = 60) => {
    for (let i = 0; i < budget; i += 1) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      if (predicate(buffered)) return true;
    }
    return false;
  };

  assert.equal(await readUntil((text) => text.includes('event: state')), true, 'the first state arrives unprompted');
  const before = buffered.match(/event: state/g).length;

  assert.equal(await readUntil((text) => text.includes(': keep-alive')), true, 'an unchanged store does not re-send state');
  assert.equal(buffered.match(/event: state/g).length, before, 'no extra state while nothing changed');

  completed = 2;
  assert.equal(
    await readUntil((text) => (text.match(/event: state/g) ?? []).length > before),
    true,
    'a change is pushed without the client asking',
  );

  controller.abort();
  await reader.cancel().catch(() => {});
  clearInterval(keepAlive);
});

test('the stream carries the open Task detail so the item table updates too', async () => {
  const keepAlive = setInterval(() => {}, 25);
  const handler = createWorkbenchHandler({
    tasks: source(), requireOperator: () => true, streamIntervalMs: 20,
    runtimeHealth: [{ async inspect() { return { schemaVersion: 1, runtime: 'bullmq', scope: 'reports', status: 'healthy', observedAt: '2026-08-11T00:00:00.000Z', queue: { waiting: 0, active: 1, delayed: 0, failed: 0, completed: 2, paused: false }, workers: { observable: true, connected: 1 } }; } }],
  });
  const controller = new AbortController();
  const response = await handler(new Request(
    'http://app.test/rhinoq/api/stream?task=task-1',
    { signal: controller.signal },
  ));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  for (let i = 0; i < 40 && !buffered.includes('event: state'); i += 1) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
  }
  const payload = JSON.parse(buffered.split('event: state\ndata: ')[1].split('\n\n')[0]);

  assert.equal(payload.detail.task.id, 'task-1');
  assert.equal(payload.detail.items[0].externalId, 'bull-job-a');
  assert.equal(payload.runtimeHealth[0].scope, 'reports');
  controller.abort();
  await reader.cancel().catch(() => {});
  clearInterval(keepAlive);
});

test('the stream is behind the operator gate like everything else', async () => {
  const handler = createWorkbenchHandler({ tasks: source(), requireOperator: () => false });
  const response = await handler(new Request('http://app.test/rhinoq/api/stream'));
  assert.equal(response.status, 403);
  assert.ok(!(await response.text()).includes('bull-job-a'));
});

// createNodeTaskMiddleware ends a response with `await result.text()`. For a
// stream that never finishes, that hangs the request rather than failing it —
// the one outcome the client fallback cannot detect quickly. This middleware
// pumps instead, so the Express/NestJS mount is realtime.
test('the Node middleware streams instead of buffering', async () => {
  const { createNodeWorkbenchMiddleware } = await import('../dist/index.js');
  const keepAlive = setInterval(() => {}, 25);
  const middleware = createNodeWorkbenchMiddleware({
    tasks: source(), requireOperator: () => true, streamIntervalMs: 20, basePath: '/admin/rhinoq',
  });

  const chunks = [];
  let closeListener = () => {};
  let ended = false;
  const request = {
    url: '/admin/rhinoq/api/stream',
    method: 'GET',
    headers: {},
    on(event, listener) { if (event === 'close') closeListener = listener; },
  };
  const response = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    write(chunk) { chunks.push(Buffer.from(chunk).toString('utf8')); },
    end() { ended = true; },
    flushHeaders() {},
  };

  middleware(request, response);
  for (let i = 0; i < 50 && !chunks.join('').includes('event: state'); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /text\/event-stream/);
  assert.ok(chunks.join('').includes('event: state'), 'data arrived before the response ended');
  assert.equal(ended, false, 'a stream must not be closed to deliver its first payload');

  closeListener();                      // the browser goes away
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(ended, true, 'aborting the request ends the response');
  clearInterval(keepAlive);
});

test('the Node middleware passes unrelated paths to the next handler', async () => {
  const { createNodeWorkbenchMiddleware } = await import('../dist/index.js');
  const middleware = createNodeWorkbenchMiddleware({
    tasks: source(), requireOperator: () => true, basePath: '/admin/rhinoq',
  });
  let passed = false;
  middleware(
    { url: '/api/videos', method: 'GET', headers: {}, on() {} },
    { statusCode: 0, setHeader() {}, write() {}, end() {} },
    () => { passed = true; },
  );
  assert.equal(passed, true);
});
