# File artifacts with S3, Cloudinary or another provider

RhinoQ can own the repeated plumbing around files produced by an async Task:
upload, SHA-256, durable metadata, owner/tenant authorization, short-lived
download resolution and the Task Center file panel. The application still owns
its cloud account and credentials.

## Handler code

The handler is provider-independent:

```ts
const exportReport = task({
  name: 'report.export',
  run: async ({ reportId }, context) => context.artifact.file(
    await generateReport(reportId),
    { name: `${reportId}.pdf`, contentType: 'application/pdf' },
  ),
});
```

Configure one provider when the application starts. `artifactProvider` wires
both `context.artifact.file()` and the existing owner-safe download endpoint;
do not also pass the older low-level `artifactStorage` option.

For multi-gigabyte video, archives, backups, datasets or model files, never put
the bytes in a queue payload and do not use the buffered `file()` helper. Pass a
private object reference in the Task input, stream the transformation, then
stream the output:

```ts
const transcode = task({
  name: 'video.transcode',
  run: async ({ sourceKey }, context) => context.artifact.stream(
    transcodeVideoAsStream(sourceKey, { signal: context.signal }),
    {
      name: 'output.mp4', contentType: 'video/mp4',
      sizeBytes: expectedOutputBytes,
      reportProgress: true,
    },
  ),
});
```

`stream()` consumes an `AsyncIterable<Uint8Array>` with backpressure, calculates
SHA-256 while bytes move, enforces the declared/final byte count, forwards Task
cancellation and can publish byte progress through the existing SSE/polling UI.
`filePath()` does the same for a regular file without reading it all into RAM:

```ts
return context.artifact.filePath('/work/output.mp4', {
  name: 'output.mp4', contentType: 'video/mp4', reportProgress: true,
});
```

For browser uploads, use the cloud provider's direct multipart/resumable upload
flow: the authenticated application creates a short-lived upload session, the
browser sends bytes directly to storage, and only the final private object key
is dispatched to RhinoQ. Sending gigabytes through PostgreSQL/BullMQ or the
RhinoQ API is intentionally unsupported.

## S3 and S3-compatible storage

Install the optional AWS packages, then provide only the bucket and client
configuration. RhinoQ owns PutObject, multipart upload, abort cleanup, response
headers and signed downloads:

```ts
import { createAwsS3ArtifactProvider } from '@rhinoq/node/artifacts';

const artifactProvider = await createAwsS3ArtifactProvider({
  bucket: process.env.ARTIFACT_BUCKET!,
  clientConfig: { region: process.env.AWS_REGION },
  maxBytes: 10 * 1024 * 1024 * 1024,
  allowedContentTypes: ['application/pdf', 'video/mp4'],
});

const app = await createRhinoQApp({
  pool, adapters, ownerFromNodeRequest, artifactProvider,
});
```

The factory lazily loads `@aws-sdk/client-s3`, `@aws-sdk/lib-storage` and
`@aws-sdk/s3-request-presigner`; applications not using AWS do not install
them. For R2, MinIO or another S3-compatible service, set `endpoint`,
`credentials`, `region` and `forcePathStyle` in `clientConfig`. The lower-level
`createS3CompatibleArtifactProvider()` remains available for another SDK.

## Cloudinary

Cloudinary SDK shapes differ between versions and delivery modes, so the
adapter also accepts two explicit callbacks. Upload as an authenticated/private
asset and return the exact `public_id` RhinoQ supplied.

For large video, supply `uploadStream` using Cloudinary's chunked upload API.
RhinoQ supplies the measured stream, stable public ID, byte count and abort
signal; the application selects Cloudinary's chunk size and authenticated
delivery mode.

```ts
import { createCloudinaryArtifactProvider } from '@rhinoq/node/artifacts';

const artifactProvider = createCloudinaryArtifactProvider({
  cloudName: process.env.CLOUDINARY_CLOUD_NAME!,
  folder: 'rhinoq',
  allowedContentTypes: ['application/pdf', 'image/png', 'image/jpeg'],
  upload: async ({ publicId, data, context }) => {
    const result = await uploadPrivateBuffer(data, { publicId, context });
    return { publicId: result.public_id, resourceType: result.resource_type };
  },
  signedDelivery: ({ publicId, resourceType, expiresInSeconds, fileName }) =>
    createPrivateCloudinaryURL({ publicId, resourceType, expiresInSeconds, fileName }),
});
```

`uploadPrivateBuffer` and `createPrivateCloudinaryURL` are intentionally
application-owned because Cloudinary authentication and delivery type are
deployment policy, not a safe value for RhinoQ to guess.

## Another storage service

Implement `RhinoQArtifactProvider` with two operations:

- `storage.put()` writes bytes privately and returns an opaque reference;
- `resolve()` validates the reference namespace and returns a short-lived
  owner-safe URL.

The owner and tenant checks occur before `resolve()`. The provider must still
reject references outside its configured bucket/folder. Never return cloud
credentials, a permanent public URL or the opaque storage reference to the
browser.

The Task Center displays name, MIME type, human-readable size, expiry and a
checksum-copy action. Clicking Download asks the server for a new signed URL,
so no cloud credential or signing secret is placed in frontend code.
