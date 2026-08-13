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

## S3 and S3-compatible storage

The adapter uses small structural callbacks, so AWS S3, Cloudflare R2, MinIO,
DigitalOcean Spaces and other S3-compatible clients do not become mandatory
dependencies of every RhinoQ install.

```ts
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createS3CompatibleArtifactProvider } from '@rhinoq/node/artifacts';

const s3 = new S3Client({ region: process.env.AWS_REGION });
const artifactProvider = createS3CompatibleArtifactProvider({
  bucket: process.env.ARTIFACT_BUCKET!,
  prefix: 'rhinoq/',
  maxBytes: 100 * 1024 * 1024,
  allowedContentTypes: ['application/pdf', 'text/csv', 'image/png'],
  putObject: async ({ bucket, key, body, contentType, checksumSha256, metadata }) => {
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: key, Body: body, ContentType: contentType,
      ChecksumSHA256: Buffer.from(checksumSha256, 'hex').toString('base64'),
      Metadata: metadata,
    }));
  },
  signGetObject: ({ bucket, key, expiresInSeconds, fileName, contentType }) =>
    getSignedUrl(s3, new GetObjectCommand({
      Bucket: bucket, Key: key,
      ResponseContentType: contentType,
      ResponseContentDisposition: `attachment; filename="${fileName.replace(/["\\]/g, '_')}"`,
    }), { expiresIn: expiresInSeconds }),
});

const app = await createRhinoQApp({
  pool, adapters, ownerFromNodeRequest, artifactProvider,
});
```

For R2, MinIO or another S3-compatible service, configure its endpoint and
path-style/region behavior on the application-owned `S3Client`; RhinoQ's code
does not change.

## Cloudinary

Cloudinary SDK shapes differ between versions and delivery modes, so the
adapter also accepts two explicit callbacks. Upload as an authenticated/private
asset and return the exact `public_id` RhinoQ supplied.

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
