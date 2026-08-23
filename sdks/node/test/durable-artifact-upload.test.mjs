import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactUploadService, defineRhinoQTask } from '../dist/index.js';

class MemoryStore {
  rows = new Map();
  async create(value) { this.rows.set(value.id, value); return value; }
  async getForOwner(id, ownerId, tenantId) { const value = this.rows.get(id); if (!value || value.ownerId !== ownerId || value.tenantId !== tenantId) throw new Error('RHINOQ_ARTIFACT_UPLOAD_NOT_FOUND'); return value; }
  async save(value, expectedVersion) { const current = this.rows.get(value.id); if (!current || current.version !== expectedVersion) throw new Error('version conflict'); const saved = { ...value, version: expectedVersion + 1 }; this.rows.set(value.id, saved); return saved; }
  async claimExpired() { return []; }
}

test('worker multipart resumes an accepted provider part and rejects a changed replay source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rhinoq-worker-upload-'));
  try {
    const path = join(root, 'video.mp4'); const size = 5 * 1024 * 1024 + 3;
    await writeFile(path, Buffer.alloc(size, 7));
    const parts = new Map(), calls = []; let created = 0, failAfterRemotePart = true, completed = 0;
    const provider = { storage: { put() {} }, resolve() {}, direct: {
      name: 'fake', async create() { created += 1; return { uploadId: 'upload-1', reference: 'fake://private/video' }; }, async signPart() { throw new Error('browser signing must not run'); },
      async uploadPart({ partNumber, body }) { calls.push(partNumber); parts.set(partNumber, { partNumber, etag: `etag-${partNumber}`, sizeBytes: body.byteLength }); if (partNumber === 1 && failAfterRemotePart) { failAfterRemotePart = false; throw new Error('worker stopped after provider accepted part'); } return { etag: `etag-${partNumber}` }; },
      async listParts() { return [...parts.values()]; }, async complete() { completed += 1; }, async abort() {}, async verify(input) { return { sizeBytes: input.expectedSizeBytes, contentType: input.contentType }; },
    } };
    const service = new ArtifactUploadService(provider, new MemoryStore(), undefined, undefined, async () => {});
    const request = { path, taskId: 'task-1', executionId: 'execution-1', artifactId: 'artifact-1', ownerId: 'owner-1', tenantId: 'tenant-1', name: 'video.mp4', contentType: 'video/mp4' };
    await assert.rejects(() => service.uploadWorkerFile(request), /worker stopped/);
    const result = await service.uploadWorkerFile(request);
    assert.equal(result.session.state, 'completed'); assert.equal(created, 1); assert.deepEqual(calls, [1, 2]); assert.equal(completed, 1); assert.deepEqual(result.session.parts.map((part) => part.partNumber), [1, 2]);
    await writeFile(path, Buffer.alloc(size, 8));
    await assert.rejects(() => service.uploadWorkerFile(request), /does not match the replayable file input/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('worker filePath uses the authenticated durable multipart service, not the one-shot stream path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rhinoq-worker-file-path-'));
  try {
    const path = join(root, 'video.mp4'); await writeFile(path, new Uint8Array([1, 2, 3, 4]));
    const calls = [], authorized = [], registered = [], progress = [];
    const task = defineRhinoQTask({ async dispatch() {} }, {
      name: 'video.file', adapter: 'manual', runtime: 'manual', scope: 'video',
      run: async (_input, context) => context.artifact.filePath(path, { name: 'ready.mp4', contentType: 'video/mp4', reportProgress: true }),
    }, { artifacts: {
      storage: { async put() { throw new Error('buffered path must not run'); }, async putStream() { throw new Error('streaming path must not run'); } },
      async register(_taskId, request) { registered.push(request); return request; },
      durableMultipart: {
        uploads: { async uploadWorkerFile(input) { calls.push(input); await input.onProgress?.({ uploadedBytes: 4, totalBytes: 4 }); return { session: { sizeBytes: 4, checksumSha256: 'a'.repeat(64), reference: 's3://private/ready.mp4', artifactExpiresAt: '2026-09-01T00:00:00.000Z' } }; } },
        async authorizeTask(taskId, ownerId, tenantId) { authorized.push([taskId, ownerId, tenantId]); },
      },
    } });
    const output = await task.workerHandler()({ data: { taskName: 'video.file', definitionVersion: 1, taskId: 'task-1', executionId: 'execution-1', ownerId: 'owner-1', tenantId: 'tenant-1', payload: {} }, updateProgress(value) { progress.push(value); } });
    assert.equal(calls.length, 1); assert.equal(calls[0].artifactId, output.id); assert.deepEqual(authorized, [['task-1', 'owner-1', 'tenant-1']]); assert.equal(registered[0].reference, 's3://private/ready.mp4'); assert.deepEqual(progress, [{ completed: 4, total: 4, message: 'Uploading ready.mp4' }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
