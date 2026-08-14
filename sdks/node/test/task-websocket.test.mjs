import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskWebSocketHub } from '../dist/index.js';

function snapshot(version, ownerId = 'owner-a') {
  return { schemaVersion: 1, entityVersion: version, id: 'task-1', type: 'report', ownerId, state: 'running',
    cancellation: { status: 'none' }, progress: { completed: version, total: 10 }, hasResult: false,
    createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:01.000Z' };
}

function peer(bufferedAmount = 0) {
  return { frames: [], closes: [], bufferedAmount,
    send(frame) { this.frames.push(JSON.parse(frame)); },
    close(code, reason) { this.closes.push({ code, reason }); } };
}

test('WebSocket hub multiplexes subscriptions and coalesces one authoritative read per owner Task', async () => {
  let reads = 0, version = 1;
  const hub = createTaskWebSocketHub({ async getTaskSummaryForOwner(taskId, ownerId, tenantId) {
    reads++; assert.equal(taskId, 'task-1'); assert.equal(ownerId, 'owner-a'); assert.equal(tenantId, 'tenant-a'); return snapshot(version);
  } }, { refreshIntervalMs: 60_000 });
  const first = peer(), second = peer();
  const a = hub.accept(first, { ownerId: 'owner-a', tenantId: 'tenant-a' });
  const b = hub.accept(second, { ownerId: 'owner-a', tenantId: 'tenant-a' });
  await a.receive(JSON.stringify({ type: 'subscribe', taskId: 'task-1' }));
  const readsAfterFirstSubscriber = reads;
  await b.receive(JSON.stringify({ type: 'subscribe', taskId: 'task-1' }));
  assert.equal(reads, readsAfterFirstSubscriber, 'a cached frame serves a later subscriber without another read');
  reads = 0; version = 2; await hub.refresh();
  assert.equal(reads, 1);
  assert.equal(first.frames.at(-1).version, 2); assert.equal(second.frames.at(-1).version, 2);
  reads = 0; await hub.refresh(); assert.equal(reads, 1);
  assert.equal(first.frames.filter((frame) => frame.type === 'task.snapshot' && frame.version === 2).length, 1);
  hub.close();
});

test('event-driven invalidation refreshes only the addressed owner group', async () => {
  const reads = [];
  const hub = createTaskWebSocketHub({ async getTaskSummaryForOwner(taskId, ownerId) {
    reads.push(`${ownerId}:${taskId}`); return snapshot(reads.length, ownerId);
  } }, { refreshIntervalMs: 60_000 });
  const ownerA = hub.accept(peer(), { ownerId: 'owner-a' });
  const ownerB = hub.accept(peer(), { ownerId: 'owner-b' });
  await ownerA.receive(JSON.stringify({ type: 'subscribe', taskId: 'task-1' }));
  await ownerB.receive(JSON.stringify({ type: 'subscribe', taskId: 'task-1' }));
  reads.length = 0;
  await hub.invalidate('task-1', { ownerId: 'owner-a' }, 99);
  assert.deepEqual(reads, ['owner-a:task-1']);
  hub.close();
});

test('WebSocket hub validates messages, bounds subscriptions and handles slow consumers', async () => {
  const hub = createTaskWebSocketHub({ async getTaskSummaryForOwner() { return snapshot(1); } }, {
    refreshIntervalMs: 60_000, maxSubscriptionsPerConnection: 1, maxBufferedBytes: 1_024, maxMessageBytes: 256,
  });
  const socket = peer(); const session = hub.accept(socket, { ownerId: 'owner-a' });
  await session.receive('{bad');
  await session.receive('x'.repeat(257));
  await session.receive(JSON.stringify({ type: 'subscribe', taskId: 'task-1' }));
  await session.receive(JSON.stringify({ type: 'subscribe', taskId: 'task-2' }));
  assert.ok(socket.frames.some((frame) => frame.code === 'RHINOQ_REALTIME_INVALID_MESSAGE'));
  assert.ok(socket.frames.some((frame) => frame.code === 'RHINOQ_REALTIME_MESSAGE_TOO_LARGE'));
  assert.ok(socket.frames.some((frame) => frame.code === 'RHINOQ_REALTIME_SUBSCRIPTION_LIMIT'));

  const slow = peer(2_048); const slowSession = hub.accept(slow, { ownerId: 'owner-a' });
  await slowSession.receive(JSON.stringify({ type: 'ping' }));
  assert.deepEqual(slow.closes, [{ code: 1013, reason: 'RHINOQ_REALTIME_BACKPRESSURE' }]);
  assert.equal(hub.connectionCount, 1);
  hub.close();
});

test('WebSocket hub never accepts an unauthenticated owner identity', () => {
  const hub = createTaskWebSocketHub({ async getTaskSummaryForOwner() { return snapshot(1); } }, { refreshIntervalMs: 60_000 });
  assert.throws(() => hub.accept(peer(), { ownerId: '' }), /authenticated ownerId/);
  hub.close();
});
