#!/usr/bin/env node

import type { TaskSnapshot } from '../gateway/types.js';

const USAGE = `Usage:
  rhinoq-task-check <application-task-url> <task-id>

Example:
  rhinoq-task-check http://localhost:3000/tasks report_01

Optional JSON request headers may be supplied through RHINOQ_TASK_HEADERS_JSON.
This command is read-only. It verifies owner-endpoint reachability, Snapshot v1
shape and non-regressing aggregate versions across two sequential reads.
`;

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  const baseUrl = process.argv[2]?.replace(/\/+$/, '');
  const taskId = process.argv[3];
  if (!baseUrl || !taskId) throw new TypeError(USAGE.trim());
  const headers = requestHeaders();
  const first = await read(`${baseUrl}/${encodeURIComponent(taskId)}`, headers);
  const second = await read(`${baseUrl}/${encodeURIComponent(taskId)}`, headers);
  if (second.entityVersion < first.entityVersion) {
    throw new Error(`Task version regressed from ${first.entityVersion} to ${second.entityVersion}`);
  }
  process.stdout.write(
    `RhinoQ Task endpoint ready: ${second.id} ${second.state} v${second.entityVersion}.\n`,
  );
}

async function read(url: string, headers: HeadersInit): Promise<TaskSnapshot> {
  const response = await fetch(url, { headers });
  const payload = await response.json() as unknown;
  if (!response.ok) throw new Error(`Task endpoint returned HTTP ${response.status}`);
  if (!isSnapshot(payload)) throw new Error('Task endpoint did not return Snapshot v1');
  return payload;
}

function requestHeaders(): HeadersInit {
  const raw = process.env.RHINOQ_TASK_HEADERS_JSON;
  if (!raw) return {};
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('RHINOQ_TASK_HEADERS_JSON must be a JSON object');
  }
  return value as Record<string, string>;
}

function isSnapshot(value: unknown): value is TaskSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<TaskSnapshot>;
  return snapshot.schemaVersion === 1 &&
    typeof snapshot.entityVersion === 'number' &&
    Number.isInteger(snapshot.entityVersion) &&
    snapshot.entityVersion > 0 &&
    typeof snapshot.id === 'string' &&
    typeof snapshot.state === 'string' &&
    !!snapshot.progress &&
    Array.isArray(snapshot.executions);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
