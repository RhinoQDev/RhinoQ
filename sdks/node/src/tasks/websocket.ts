import type { TaskSummary } from '../gateway/types.js';

export const TASK_WEBSOCKET_PROTOCOL_VERSION = 1 as const;

export interface TaskWebSocketSource {
  getTaskSummaryForOwner(taskId: string, ownerId: string, tenantId?: string): Promise<TaskSummary>;
}

/** Stack-neutral socket boundary. Adapt `ws`, Socket.IO, uWebSockets.js or a platform WebSocket to this shape. */
export interface TaskWebSocketPeer {
  send(data: string): void | Promise<void>;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount?: number;
}

export interface TaskWebSocketIdentity { ownerId: string; tenantId?: string }
export interface TaskWebSocketHubOptions {
  refreshIntervalMs?: number;
  heartbeatMs?: number;
  maxConnections?: number;
  maxSubscriptionsPerConnection?: number;
  maxBufferedBytes?: number;
  maxMessageBytes?: number;
}

export type TaskWebSocketClientMessage =
  | { type: 'subscribe'; taskId: string; lastVersion?: number }
  | { type: 'unsubscribe'; taskId: string }
  | { type: 'ping' };

export type TaskWebSocketServerMessage =
  | { schemaVersion: 1; type: 'ready'; connectionId: string }
  | { schemaVersion: 1; type: 'task.snapshot'; taskId: string; version: number; task: TaskSummary }
  | { schemaVersion: 1; type: 'task.unsubscribed'; taskId: string }
  | { schemaVersion: 1; type: 'heartbeat'; serverTime: string }
  | { schemaVersion: 1; type: 'pong'; serverTime: string }
  | { schemaVersion: 1; type: 'error'; code: string; taskId?: string };

export interface TaskWebSocketSession {
  readonly id: string;
  receive(data: string | Uint8Array): Promise<void>;
  close(): void;
}

/**
 * Multiplexed realtime delivery over an application-owned WebSocket server.
 * The hub batches all subscribers for the same owner/tenant/task into one
 * authoritative read and serializes a new version once before fan-out.
 */
export function createTaskWebSocketHub(source: TaskWebSocketSource, options: TaskWebSocketHubOptions = {}) {
  if (!source || typeof source.getTaskSummaryForOwner !== 'function') throw new TypeError('Task WebSocket source is required');
  const refreshMs = bounded(options.refreshIntervalMs ?? 500, 100, 60_000, 'refreshIntervalMs');
  const heartbeatMs = bounded(options.heartbeatMs ?? 15_000, 1_000, 120_000, 'heartbeatMs');
  const maxConnections = integer(options.maxConnections ?? 1_000, 1, 100_000, 'maxConnections');
  const maxSubscriptions = integer(options.maxSubscriptionsPerConnection ?? 100, 1, 1_000, 'maxSubscriptionsPerConnection');
  const maxBufferedBytes = integer(options.maxBufferedBytes ?? 1_048_576, 1_024, 67_108_864, 'maxBufferedBytes');
  const maxMessageBytes = integer(options.maxMessageBytes ?? 16_384, 256, 1_048_576, 'maxMessageBytes');
  const sessions = new Map<string, Session>();
  const groups = new Map<string, Group>();
  let sequence = 0;

  const timer = setInterval(() => { void refresh(); }, refreshMs);
  timer.unref?.();
  const heartbeat = setInterval(() => {
    const frame = JSON.stringify({ schemaVersion: 1, type: 'heartbeat', serverTime: new Date().toISOString() });
    for (const session of sessions.values()) void send(session, frame);
  }, heartbeatMs);
  heartbeat.unref?.();

  async function refresh(): Promise<void> {
    await Promise.all([...groups.values()].map(refreshGroup));
  }

  async function invalidate(taskId: string, identity?: TaskWebSocketIdentity, minimumVersion?: number): Promise<void> {
    if (!validTaskId(taskId)) throw new TypeError('valid taskId is required');
    if (minimumVersion !== undefined && (!Number.isSafeInteger(minimumVersion) || minimumVersion < 0)) throw new RangeError('minimumVersion must be a non-negative safe integer');
    const selected = identity?.ownerId
      ? [groups.get(groupKey({ ownerId: identity.ownerId, tenantId: identity.tenantId ?? 'default' }, taskId))].filter((group): group is Group => Boolean(group))
      : [...groups.values()].filter((group) => group.taskId === taskId);
    await Promise.all(selected.filter((group) => minimumVersion === undefined || minimumVersion > group.latestVersion).map(refreshGroup));
  }

  async function refreshGroup(group: Group): Promise<void> {
    group.pending = true;
    if (group.inFlight) return group.inFlight;
    group.inFlight = (async () => {
      while (group.pending && group.members.size) {
        group.pending = false;
        try {
          const task = await source.getTaskSummaryForOwner(group.taskId, group.identity.ownerId, group.identity.tenantId ?? 'default');
          if (task.entityVersion <= group.latestVersion) continue;
          group.latestVersion = task.entityVersion;
          group.frame = JSON.stringify({ schemaVersion: 1, type: 'task.snapshot', taskId: group.taskId, version: task.entityVersion, task });
          const interested = [...group.members].filter((member) => task.entityVersion > (member.subscriptions.get(group.taskId) ?? -1));
          await Promise.all(interested.map(async (member) => { member.subscriptions.set(group.taskId, task.entityVersion); await send(member, group.frame!); }));
        } catch { await Promise.all([...group.members].map((member) => sendMessage(member, { schemaVersion: 1, type: 'error', code: 'RHINOQ_REALTIME_READ_FAILED', taskId: group.taskId }))); }
      }
    })().finally(() => { group.inFlight = undefined; });
    return group.inFlight;
  }

  function accept(peer: TaskWebSocketPeer, identity: TaskWebSocketIdentity): TaskWebSocketSession {
    if (!identity.ownerId?.trim()) throw new TypeError('authenticated ownerId is required');
    if (!peer || typeof peer.send !== 'function' || typeof peer.close !== 'function') throw new TypeError('WebSocket peer is required');
    if (sessions.size >= maxConnections) { peer.close(1013, 'RHINOQ_REALTIME_CAPACITY'); throw new Error('RHINOQ_REALTIME_CAPACITY'); }
    const session: Session = { id: `rhinoq-ws-${++sequence}`, peer, identity: { ownerId: identity.ownerId, tenantId: identity.tenantId ?? 'default' }, subscriptions: new Map(), closed: false };
    sessions.set(session.id, session);
    void sendMessage(session, { schemaVersion: 1, type: 'ready', connectionId: session.id });
    return {
      id: session.id,
      async receive(data) {
        if (session.closed) return;
        const size = typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength;
        if (size > maxMessageBytes) { await sendMessage(session, { schemaVersion: 1, type: 'error', code: 'RHINOQ_REALTIME_MESSAGE_TOO_LARGE' }); return; }
        let message: TaskWebSocketClientMessage;
        try { message = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)) as TaskWebSocketClientMessage; }
        catch { await sendMessage(session, { schemaVersion: 1, type: 'error', code: 'RHINOQ_REALTIME_INVALID_MESSAGE' }); return; }
        if (message.type === 'ping') { await sendMessage(session, { schemaVersion: 1, type: 'pong', serverTime: new Date().toISOString() }); return; }
        if ((message.type !== 'subscribe' && message.type !== 'unsubscribe') || !validTaskId(message.taskId)) { await sendMessage(session, { schemaVersion: 1, type: 'error', code: 'RHINOQ_REALTIME_INVALID_MESSAGE' }); return; }
        if (message.type === 'unsubscribe') { removeSubscription(session, message.taskId); await sendMessage(session, { schemaVersion: 1, type: 'task.unsubscribed', taskId: message.taskId }); return; }
        if (!session.subscriptions.has(message.taskId) && session.subscriptions.size >= maxSubscriptions) { await sendMessage(session, { schemaVersion: 1, type: 'error', code: 'RHINOQ_REALTIME_SUBSCRIPTION_LIMIT', taskId: message.taskId }); return; }
        const lastVersion = Number.isSafeInteger(message.lastVersion) && (message.lastVersion ?? -1) >= 0 ? message.lastVersion! : -1;
        session.subscriptions.set(message.taskId, lastVersion);
        const key = groupKey(session.identity, message.taskId);
        const group = groups.get(key) ?? { key, identity: session.identity, taskId: message.taskId, members: new Set<Session>(), latestVersion: -1, pending: false };
        group.members.add(session); groups.set(key, group);
        if (group.frame && group.latestVersion > lastVersion) { session.subscriptions.set(message.taskId, group.latestVersion); await send(session, group.frame); }
        else await refreshGroup(group);
      },
      close: () => close(session),
    };
  }

  function removeSubscription(session: Session, taskId: string): void {
    session.subscriptions.delete(taskId);
    const key = groupKey(session.identity, taskId); const group = groups.get(key);
    group?.members.delete(session); if (group && !group.members.size) groups.delete(key);
  }
  function close(session: Session): void {
    if (session.closed) return; session.closed = true; sessions.delete(session.id);
    for (const taskId of [...session.subscriptions.keys()]) removeSubscription(session, taskId);
  }
  async function send(session: Session, frame: string): Promise<void> {
    if (session.closed) return;
    if ((session.peer.bufferedAmount ?? 0) > maxBufferedBytes) { close(session); session.peer.close(1013, 'RHINOQ_REALTIME_BACKPRESSURE'); return; }
    try { await session.peer.send(frame); } catch { close(session); }
  }
  function sendMessage(session: Session, message: TaskWebSocketServerMessage): Promise<void> { return send(session, JSON.stringify(message)); }

  return {
    accept,
    /** Reconcile every subscribed group; normally only the safety-net timer calls this. */
    refresh,
    /** Event-driven fast path: call after a Task write or from LISTEN/NOTIFY, Redis or NATS. */
    invalidate,
    close() { clearInterval(timer); clearInterval(heartbeat); for (const session of sessions.values()) { session.peer.close(1001, 'RHINOQ_REALTIME_SHUTDOWN'); close(session); } },
    get connectionCount() { return sessions.size; },
  };
}

interface Session { id: string; peer: TaskWebSocketPeer; identity: TaskWebSocketIdentity; subscriptions: Map<string, number>; closed: boolean }
interface Group { key: string; identity: TaskWebSocketIdentity; taskId: string; members: Set<Session>; latestVersion: number; frame?: string; pending: boolean; inFlight?: Promise<void> }
function groupKey(identity: TaskWebSocketIdentity, taskId: string): string { return `${identity.tenantId ?? 'default'}\0${identity.ownerId}\0${taskId}`; }
function validTaskId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value); }
function bounded(value: number, min: number, max: number, name: string): number { if (!Number.isFinite(value) || value < min || value > max) throw new RangeError(`${name} must be ${min}..${max}`); return value; }
function integer(value: number, min: number, max: number, name: string): number { if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer ${min}..${max}`); return value; }
