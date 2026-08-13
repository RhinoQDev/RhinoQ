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

The shortest S3 setup reads a dedicated, documented environment namespace:

```ts
const app = await createRhinoQApp({
  pool, adapters, ownerFromNodeRequest,
  artifacts: 's3',
});
```

```env
RHINOQ_ARTIFACT_BUCKET=my-private-files
RHINOQ_ARTIFACT_REGION=ap-southeast-1
RHINOQ_ARTIFACT_MAX_BYTES=10737418240
# Optional for R2/MinIO/Spaces:
RHINOQ_ARTIFACT_ENDPOINT=
RHINOQ_ARTIFACT_FORCE_PATH_STYLE=false
RHINOQ_ARTIFACT_CONTENT_TYPES=video/mp4,application/pdf,application/zip
```

Environment credentials continue to use the AWS SDK's normal credential chain;
RhinoQ does not parse, persist or expose access keys.

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
  reportProgress: true,
});
```

`filePath()` infers the file name and common MIME types. For standard output
types the shorter helpers also turn on progress automatically:

```ts
return context.output.video('/work/output.mp4');
return context.output.pdf('/work/report.pdf');
return context.output.archive('/work/export.zip');
```

Multiple output files can remain separately downloadable:

```ts
return context.output.files(['/work/front.jpg', '/work/back.jpg'], {
  concurrency: 4,
});
```

Or install the optional `archiver` package and stream one ZIP directly to the
configured provider—without holding the ZIP or its input files in memory:

```ts
return context.output.zip(paths, { name: 'all-results.zip', maxItems: 500 });
```

Both helpers reject duplicate basenames and do not accept an unbounded directory
glob. `files()` defaults to at most 100 outputs—the same bound used by the
owner API and Task Center—and limits concurrent uploads to 4 (configurable
from 1 to 16). `zip()` defaults to 100 inputs and allows an explicit bound up
to 1,000 because it registers only one final artifact. ZIP creation forwards
cancellation and inherits the provider's upload size/MIME policy.

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

## Direct resumable browser upload

The AWS S3 provider supports durable multipart upload. Bytes travel directly
from browser to S3; the owner API only creates, signs and reconciles the
session.

```ts
import { uploadArtifactFile } from '@rhinoq/node/browser';

await uploadArtifactFile(taskClient, file, {
  taskId,
  checksumSha256, // required for a Task-bound artifact
  concurrency: 4,
  onProgress: ({ uploadedBytes, totalBytes }) => renderProgress(uploadedBytes / totalBytes),
});
```

Persist the session ID while uploading and pass it back as `sessionId` to
resume. RhinoQ lists provider parts and skips those already present. Task
ownership is checked before provider access. Lost completion/readback becomes
`uncertain`, never success or a blind retry. Resume and complete again to run
readback-only reconciliation; RhinoQ does not send multipart complete twice.
Session expiry defaults to 24 hours; artifact expiry defaults to seven days. The helper deliberately does not
hash a multi-GB Blob in memory, so callers provide lowercase SHA-256 when
attaching it to a Task.

## Retention cleanup

When provider deletion is available, call
`app.artifactRetention.preview(25)` before the explicit
`app.artifactRetention.sweep({ delete: true, limit: 25 })`. Rows are leased
with `SKIP LOCKED`; provider deletion precedes metadata deletion and the Task
snapshot advances. Failed deletion remains visible for operator review.

## Media presets

With FFmpeg on `PATH` (or `RHINOQ_FFMPEG_PATH`):

```ts
return context.media.transcode('/work/input.mov', '/work/output.mp4', {
  videoCodec: 'libx264', preset: 'balanced', timeoutMs: 30 * 60_000,
});
```

`context.media.thumbnail(input, output, { atSeconds, width })` follows the same
path. RhinoQ handles cancellation, timeout, bounded stderr, exit/output checks
and artifact registration. The application still chooses codecs, retention and
business retry.
