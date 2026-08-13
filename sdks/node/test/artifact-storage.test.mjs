import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCloudinaryArtifactProvider, createS3CompatibleArtifactProvider } from '../dist/artifacts-entry.js';

const artifact = (reference) => ({ id: 'a1', taskId: 't1', name: 'report.pdf', contentType: 'application/pdf', reference });
const upload = { id: 'a1', taskId: 't1', executionId: 'e1', name: 'report.pdf', contentType: 'application/pdf', data: new Uint8Array([1, 2, 3]), checksumSha256: 'a'.repeat(64) };

test('S3-compatible provider uploads to a private namespace and signs owner access', async () => {
  let put;
  const provider = createS3CompatibleArtifactProvider({
    bucket: 'private-files', prefix: 'tenant-app/', allowedContentTypes: ['application/pdf'], maxBytes: 10,
    async putObject(input) { put = input; },
    async signGetObject(input) { return `https://storage.example/${input.key}?signature=one`; },
  });
  const stored = await provider.storage.put(upload);
  assert.equal(stored.reference, 's3://private-files/tenant-app/t1/a1/report.pdf');
  assert.equal(put.metadata['rhinoq-sha256'], upload.checksumSha256);
  const access = await provider.resolve(artifact(stored.reference), new Request('https://app.example/tasks/t1'), 'owner-a', 'tenant-a');
  assert.match(access.url, /^https:\/\/storage\.example\//);
  await assert.rejects(() => provider.storage.put({ ...upload, data: new Uint8Array(11) }), /exceeds 10 bytes/);
});

test('Cloudinary provider keeps publicId stable and rejects namespace substitution', async () => {
  const provider = createCloudinaryArtifactProvider({
    cloudName: 'demo', folder: 'rhinoq',
    async upload(input) { return { publicId: input.publicId, resourceType: 'raw' }; },
    async signedDelivery(input) { return `https://res.cloudinary.com/${input.cloudName}/private/${input.publicId}?sig=one`; },
  });
  const stored = await provider.storage.put(upload);
  assert.equal(stored.reference, 'cloudinary://demo/raw/rhinoq/t1/a1');
  const access = await provider.resolve(artifact(stored.reference), new Request('https://app.example'), 'owner', 'tenant');
  assert.match(access.url, /res\.cloudinary\.com/);
  await assert.rejects(() => provider.resolve(artifact('cloudinary://demo/raw/other/a1'), new Request('https://app.example'), 'owner', 'tenant'), /outside/);
});
