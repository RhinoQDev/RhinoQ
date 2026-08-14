import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileRhinoQDataPathPlan, RHINOQ_INLINE_PAYLOAD_LIMIT_BYTES } from '../dist/index.js';

test('data path planner keeps media bytes out of the queue and compiles bounded multipart metadata', () => {
  const plan = compileRhinoQDataPathPlan({
    workload: 'media',
    payloadBytes: 20 * 1024 * 1024,
    memoryBytes: 32 * 1024 * 1024,
    provider: { supportsMultipart: true, maxParts: 100 },
    workspaceBytes: 40 * 1024 * 1024,
  });
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.input.transport, 'private-reference');
  assert.equal(plan.input.queueCarries, 'private-reference');
  assert.equal(plan.output.transport, 'stream-to-storage');
  assert.equal(plan.output.checksumRequired, true);
  assert.ok(plan.multipart.partBytes >= 5 * 1024 * 1024);
  assert.ok(plan.multipart.concurrency >= 1 && plan.multipart.concurrency <= 8);
  assert.deepEqual(plan.admission, { workspaceBytes: 40 * 1024 * 1024 });
});

test('data path planner exposes fail-closed disk and codec admission decisions', () => {
  const plan = compileRhinoQDataPathPlan({
    workload: 'media',
    payloadBytes: 8 * 1024 * 1024,
    workspaceBytes: 10 * 1024 * 1024,
    minDiskFreeBytes: 10 * 1024 * 1024,
    diskFreeBytes: 5 * 1024 * 1024,
    codec: 'h265',
    provider: { supportsMultipart: true, codecs: ['h264'] },
  });
  assert.equal(plan.admission.diskFreeBytes, 5 * 1024 * 1024);
  assert.equal(plan.admission.minDiskFreeBytes, 10 * 1024 * 1024);
  assert.equal(plan.admission.codec, 'h265');
  assert.equal(plan.needsDecision.length, 2);
  assert.ok(plan.needsDecision.some((item) => item.includes('disk')));
  assert.ok(plan.needsDecision.some((item) => item.includes('codec')));
});

test('data path planner only uses inline transport below the hard limit', () => {
  const small = compileRhinoQDataPathPlan({ workload: 'task', payloadBytes: RHINOQ_INLINE_PAYLOAD_LIMIT_BYTES });
  const large = compileRhinoQDataPathPlan({ workload: 'task', payloadBytes: RHINOQ_INLINE_PAYLOAD_LIMIT_BYTES + 1 });
  assert.equal(small.input.transport, 'inline');
  assert.equal(large.input.transport, 'private-reference');
  assert.throws(() => compileRhinoQDataPathPlan({ workload: 'task', payloadBytes: -1 }), /non-negative/);
  const needsProvider = compileRhinoQDataPathPlan({ workload: 'media', payloadBytes: 10 * 1024 * 1024, provider: { supportsMultipart: false } });
  assert.ok(needsProvider.needsDecision.some((item) => item.includes('multipart')));
});
