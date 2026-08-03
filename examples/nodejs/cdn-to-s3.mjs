// Fetch an asset from a CDN and put it in object storage, as a RhinoQ
// ProviderOperation.
//
// This is the shape neither existing reference adapter covered. Stripe and
// provisioning answer "did it happen?" from a status field the provider keeps.
// A transfer has none: the only evidence is the destination object, and the
// interesting failure is not a timeout — it is finding *an* object at the key
// and having no way to tell whether it is the one this operation wrote.
//
// Run against a real Gateway:
//   RHINOQ_GATEWAY_URL=... RHINOQ_GATEWAY_TOKEN=... node examples/nodejs/cdn-to-s3.mjs
//
// The S3 and CDN calls here are stubs so the file runs without credentials.
// Replace them with the application's own client; RhinoQ never owns it.

import { RhinoQClient, objectTransferProviderAdapter } from '@rhinoq/node';

const ASSET_ID = process.env.ASSET_ID ?? 'asset-4471';
const CDN_URL = process.env.CDN_URL ?? `https://cdn.example.com/${ASSET_ID}.mp4`;
const BUCKET = process.env.S3_BUCKET ?? 'example-media';
const KEY = `assets/${ASSET_ID}.mp4`;

const transfer = objectTransferProviderAdapter({
  // Repeating this for one idempotency key must be safe. A deterministic
  // destination key is what makes it so: the second write lands on the same
  // object rather than creating a second one.
  async transfer(idempotencyKey) {
    const source = await fetch(CDN_URL);
    if (!source.ok) {
      throw new Error(`CDN returned ${source.status} for ${CDN_URL}`);
    }
    const body = Buffer.from(await source.arrayBuffer());
    const put = await s3PutObject({
      Bucket: BUCKET,
      Key: KEY,
      Body: body,
      // Passing the idempotency key through gives the provider a second
      // chance to deduplicate, and gives an operator something to grep for.
      Metadata: { 'rhinoq-idempotency-key': idempotencyKey },
    });
    return { key: KEY, etag: put.ETag, size: body.byteLength, versionId: put.VersionId };
  },

  // A HEAD, not a GET. The question is identity, not content, and downloading
  // the object again to answer it costs the egress twice.
  async head() {
    const found = await s3HeadObject({ Bucket: BUCKET, Key: KEY });
    if (!found) return undefined;
    return { key: KEY, etag: found.ETag, size: found.ContentLength, versionId: found.VersionId };
  },

  // Without this the readback can only report that something exists at the
  // key, and the confirmation stays `unknown`. With it, a half-written or
  // stale object is caught — and reported as `failed`, not retried, because
  // retrying would overwrite whatever is actually there.
  async expected() {
    const probe = await fetch(CDN_URL, { method: 'HEAD' });
    if (!probe.ok) return undefined;
    const size = Number(probe.headers.get('content-length'));
    return {
      etag: probe.headers.get('etag') ?? undefined,
      size: Number.isFinite(size) ? size : undefined,
    };
  },
});

const rhinoq = new RhinoQClient({
  url: process.env.RHINOQ_GATEWAY_URL ?? 'http://127.0.0.1:8080',
  token: process.env.RHINOQ_GATEWAY_TOKEN ?? 'replace-me-with-a-real-operator-token',
});

const operation = await rhinoq.providerOperation({
  taskId: ASSET_ID,
  name: 'storage.transfer',
  // Stable across retries of this asset, different for every other asset.
  idempotencyKey: `transfer:${BUCKET}:${KEY}`,
  confirmation: 'readback',
  // Retry only once the readback has proven the destination is empty.
  retryPolicy: 'when-not-happened',
  ...transfer,
});

console.log(`${operation.state}\t${operation.evidence ?? operation.reason ?? ''}`);
if (operation.state === 'uncertain' || operation.state === 'failed') {
  // Neither is a retry signal. `uncertain` means nobody knows yet; `failed`
  // here means the destination holds something else, and overwriting it is a
  // decision for a person.
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Stubs. Replace with @aws-sdk/client-s3 or the application's storage client.

async function s3PutObject({ Key, Body }) {
  return { ETag: `"${Body.byteLength.toString(16)}"`, VersionId: undefined, Key };
}

async function s3HeadObject() {
  // Return undefined for "no such key"; never let a NotFound become a throw
  // that the confirmation reads as an infrastructure failure.
  return undefined;
}
