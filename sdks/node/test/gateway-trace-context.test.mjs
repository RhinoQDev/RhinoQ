import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RhinoQClient,
  currentTraceParent,
  traceContextMiddleware,
  traceParentFromHeaders,
  withTrace,
} from '../dist/index.js';

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const OTHER_TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

const SNAPSHOT = {
  schemaVersion: 1,
  entityVersion: 2,
  id: 'task_01',
  type: 'report.export',
  state: 'queued',
  progress: { completed: 0 },
  hasResult: false,
  executions: [],
  createdAt: '2026-08-27T00:00:00Z',
  updatedAt: '2026-08-27T00:00:01Z',
};

/** Builds a client that records every request it would have sent. */
function recordingClient(options = {}) {
  const requests = [];
  const client = new RhinoQClient({
    url: 'http://gateway.test',
    token: 'gateway-token-that-is-at-least-32-bytes',
    fetch: async (url, init) => {
      requests.push({
        url,
        headers: init.headers,
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      return Response.json(SNAPSHOT);
    },
    ...options,
  });
  return { client, requests };
}

test('an ambient trace is attached to every Gateway call without configuration', async () => {
  const { client, requests } = recordingClient();

  await withTrace(TRACEPARENT, async () => {
    await client.getTask('task_01');
    // The context must survive an await, which is the whole reason this uses
    // AsyncLocalStorage rather than a module-level variable.
    await new Promise((resolve) => setImmediate(resolve));
    await client.createTaskExecution('task_01', { id: 'exec_01', runtime: 'native' });
  });

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.headers.traceparent, TRACEPARENT);
  }
});

test('calls outside a trace scope send no traceparent', async () => {
  const { client, requests } = recordingClient();
  await client.getTask('task_01');
  // Absence must stay absence. Sending an empty header would make every
  // untraced attempt look like it shared one trace.
  assert.equal(requests[0].headers.traceparent, undefined);
});

test('withTrace treats a blank or missing value as no trace', async () => {
  for (const value of ['', '   ', undefined, null]) {
    await withTrace(value, () => {
      assert.equal(currentTraceParent(), undefined);
    });
  }
});

test('nested scopes restore the outer trace on exit', async () => {
  await withTrace(TRACEPARENT, async () => {
    assert.equal(currentTraceParent(), TRACEPARENT);
    await withTrace(OTHER_TRACEPARENT, async () => {
      assert.equal(currentTraceParent(), OTHER_TRACEPARENT);
    });
    assert.equal(currentTraceParent(), TRACEPARENT);
  });
  assert.equal(currentTraceParent(), undefined);
});

test('a custom headers provider replaces the default and runs per request', async () => {
  let calls = 0;
  const { client, requests } = recordingClient({
    headers: () => ({ 'x-request-seq': String(++calls) }),
  });

  await withTrace(TRACEPARENT, async () => {
    await client.getTask('task_01');
    await client.getTask('task_01');
  });

  assert.equal(requests[0].headers['x-request-seq'], '1');
  assert.equal(requests[1].headers['x-request-seq'], '2');
  // An explicit provider opts out of the default, so the ambient trace is not
  // silently added behind the application's back.
  assert.equal(requests[0].headers.traceparent, undefined);
});

test('a provider returning undefined sends no extra headers', async () => {
  const { client, requests } = recordingClient({ headers: () => undefined });
  await withTrace(TRACEPARENT, () => client.getTask('task_01'));
  assert.equal(requests[0].headers.traceparent, undefined);
  assert.equal(requests[0].headers.authorization, 'Bearer gateway-token-that-is-at-least-32-bytes');
});

// The credential must be unreachable from a headers provider. Spread last, a
// provider returning an authorization key would silently replace this client's
// token with one of its own choosing for every request.
test('a headers provider cannot override authorization, accept or content-type', async () => {
  const { client, requests } = recordingClient({
    headers: () => ({
      authorization: 'Bearer stolen-credential',
      accept: 'text/html',
      'content-type': 'text/plain',
      'x-safe': 'kept',
    }),
  });

  await client.getTask('task_01');

  const headers = requests[0].headers;
  assert.equal(headers.authorization, 'Bearer gateway-token-that-is-at-least-32-bytes');
  assert.equal(headers.accept, 'application/json');
  assert.equal(headers['content-type'], 'application/json');
  // Everything else the provider asked for is still honoured.
  assert.equal(headers['x-safe'], 'kept');
});

// A diagnostic header is never worth losing real work over; the Agent applies
// the same rule when it drops a malformed traceparent.
test('a throwing headers provider does not fail the request', async () => {
  const { client, requests } = recordingClient({
    headers: () => {
      throw new Error('context lookup exploded');
    },
  });

  const snapshot = await client.getTask('task_01');
  assert.equal(snapshot.id, 'task_01');
  assert.equal(requests[0].headers.authorization, 'Bearer gateway-token-that-is-at-least-32-bytes');
});

test('an explicit request traceparent travels in the body', async () => {
  const { client, requests } = recordingClient();

  await withTrace(TRACEPARENT, () =>
    client.createTaskExecution('task_01', {
      id: 'exec_01',
      runtime: 'native',
      traceparent: OTHER_TRACEPARENT,
    }),
  );

  // Both are sent: the Agent prefers the body, which is what lets a batch
  // producer attribute each attempt to its own upstream work rather than to the
  // one call that submitted them all.
  assert.equal(requests[0].body.traceparent, OTHER_TRACEPARENT);
  assert.equal(requests[0].headers.traceparent, TRACEPARENT);
});

test('traceParentFromHeaders reads the shapes Node frameworks produce', () => {
  assert.equal(traceParentFromHeaders({ traceparent: TRACEPARENT }), TRACEPARENT);
  // HTTP does not promise a header case and proxies do not preserve one.
  assert.equal(traceParentFromHeaders({ TraceParent: TRACEPARENT }), TRACEPARENT);
  // Node produces an array when a header arrives more than once.
  assert.equal(traceParentFromHeaders({ traceparent: [TRACEPARENT, OTHER_TRACEPARENT] }), TRACEPARENT);
  assert.equal(traceParentFromHeaders(new Headers({ traceparent: TRACEPARENT })), TRACEPARENT);
  assert.equal(traceParentFromHeaders({}), undefined);
  assert.equal(traceParentFromHeaders(undefined), undefined);
  assert.equal(traceParentFromHeaders({ traceparent: '   ' }), undefined);
});

test('the middleware makes an inbound trace ambient for the rest of the request', async () => {
  const { client, requests } = recordingClient();
  const middleware = traceContextMiddleware();

  await new Promise((resolve) => {
    middleware({ headers: { traceparent: TRACEPARENT } }, {}, async () => {
      await client.getTask('task_01');
      resolve();
    });
  });

  assert.equal(requests[0].headers.traceparent, TRACEPARENT);
});

test('the middleware leaves an untraced request untraced', async () => {
  const { client, requests } = recordingClient();
  const middleware = traceContextMiddleware();

  await new Promise((resolve) => {
    middleware({ headers: {} }, {}, async () => {
      await client.getTask('task_01');
      resolve();
    });
  });

  assert.equal(requests[0].headers.traceparent, undefined);
});

test('a published traceId is readable from a snapshot', async () => {
  const withTraceId = {
    ...SNAPSHOT,
    executions: [{
      id: 'exec_01', attempt: 1, runtime: 'native', state: 'running',
      version: 1, traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    }],
  };
  const client = new RhinoQClient({
    url: 'http://gateway.test',
    fetch: async () => Response.json(withTraceId),
  });

  const snapshot = await client.getTask('task_01');
  assert.equal(snapshot.executions[0].traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
});
