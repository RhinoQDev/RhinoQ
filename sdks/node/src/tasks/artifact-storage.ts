import type { TaskArtifactRecord } from '../gateway/types.js';
import type { RhinoQArtifactStorage } from './declaration.js';

export interface RhinoQArtifactAccess { url: string; expiresAt?: string }
export interface RhinoQArtifactProvider {
  storage: RhinoQArtifactStorage;
  resolve(artifact: TaskArtifactRecord, request: Request, ownerId: string, tenantId: string): Promise<RhinoQArtifactAccess>;
}
export interface ArtifactPolicy { maxBytes?: number; allowedContentTypes?: string[]; expiresInMs?: number }

export interface S3CompatibleArtifactOptions extends ArtifactPolicy {
  bucket: string;
  prefix?: string;
  putObject(input: { bucket: string; key: string; body: Uint8Array; contentType: string; checksumSha256: string; metadata: Record<string, string> }): Promise<void>;
  signGetObject(input: { bucket: string; key: string; expiresInSeconds: number; fileName: string; contentType: string }): Promise<string> | string;
  signedUrlExpiresInSeconds?: number;
}

export function createS3CompatibleArtifactProvider(options: S3CompatibleArtifactOptions): RhinoQArtifactProvider {
  const bucket = required(options?.bucket, 'S3 bucket');
  const prefix = cleanPrefix(options.prefix ?? 'rhinoq/');
  const policy = artifactPolicy(options);
  const signedSeconds = options.signedUrlExpiresInSeconds ?? 300;
  if (typeof options.putObject !== 'function' || typeof options.signGetObject !== 'function') throw new TypeError('S3 artifact provider requires putObject and signGetObject');
  if (!Number.isInteger(signedSeconds) || signedSeconds < 30 || signedSeconds > 86_400) throw new RangeError('S3 signed URL expiry must be 30..86400 seconds');
  return {
    storage: {
      async put(input) {
        validateUpload(input.data, input.contentType, policy);
        const key = `${prefix}${safeSegment(input.taskId)}/${safeSegment(input.id)}/${encodeURIComponent(input.name)}`;
        await options.putObject({ bucket, key, body: input.data, contentType: input.contentType, checksumSha256: input.checksumSha256, metadata: { 'rhinoq-task-id': input.taskId, 'rhinoq-execution-id': input.executionId, 'rhinoq-sha256': input.checksumSha256 } });
        return { reference: `s3://${bucket}/${key}`, expiresAt: expiresAt(policy.expiresInMs) };
      },
    },
    async resolve(artifact, _request, ownerId, tenantId) {
      requireAccess(ownerId, tenantId);
      const parsed = parseS3Reference(artifact.reference);
      if (parsed.bucket !== bucket || !parsed.key.startsWith(prefix)) throw new TypeError('artifact reference is outside the configured S3 namespace');
      const url = await options.signGetObject({ bucket, key: parsed.key, expiresInSeconds: signedSeconds, fileName: artifact.name, contentType: artifact.contentType });
      requireHTTPS(url);
      return { url, expiresAt: new Date(Date.now() + signedSeconds * 1000).toISOString() };
    },
  };
}

export interface CloudinaryArtifactOptions extends ArtifactPolicy {
  cloudName: string;
  folder?: string;
  upload(input: { publicId: string; data: Uint8Array; contentType: string; fileName: string; context: Record<string, string> }): Promise<{ publicId: string; resourceType?: string }>;
  signedDelivery(input: { cloudName: string; publicId: string; resourceType: string; expiresInSeconds: number; fileName: string }): Promise<string> | string;
  signedUrlExpiresInSeconds?: number;
}

export function createCloudinaryArtifactProvider(options: CloudinaryArtifactOptions): RhinoQArtifactProvider {
  const cloudName = required(options?.cloudName, 'Cloudinary cloudName');
  const folder = cleanPrefix(options.folder ?? 'rhinoq/').replace(/\/$/, '');
  const policy = artifactPolicy(options);
  const signedSeconds = options.signedUrlExpiresInSeconds ?? 300;
  if (typeof options.upload !== 'function' || typeof options.signedDelivery !== 'function') throw new TypeError('Cloudinary artifact provider requires upload and signedDelivery');
  if (!Number.isInteger(signedSeconds) || signedSeconds < 30 || signedSeconds > 86_400) throw new RangeError('Cloudinary signed URL expiry must be 30..86400 seconds');
  return {
    storage: {
      async put(input) {
        validateUpload(input.data, input.contentType, policy);
        const expected = `${folder}/${safeSegment(input.taskId)}/${safeSegment(input.id)}`;
        const uploaded = await options.upload({ publicId: expected, data: input.data, contentType: input.contentType, fileName: input.name, context: { rhinoq_task_id: input.taskId, rhinoq_execution_id: input.executionId, rhinoq_sha256: input.checksumSha256 } });
        if (uploaded.publicId !== expected) throw new TypeError('Cloudinary upload returned a different publicId');
        return { reference: `cloudinary://${cloudName}/${uploaded.resourceType ?? 'raw'}/${uploaded.publicId}`, expiresAt: expiresAt(policy.expiresInMs) };
      },
    },
    async resolve(artifact, _request, ownerId, tenantId) {
      requireAccess(ownerId, tenantId);
      const parsed = parseCloudinaryReference(artifact.reference);
      if (parsed.cloudName !== cloudName || !parsed.publicId.startsWith(`${folder}/`)) throw new TypeError('artifact reference is outside the configured Cloudinary namespace');
      const url = await options.signedDelivery({ ...parsed, expiresInSeconds: signedSeconds, fileName: artifact.name });
      requireHTTPS(url);
      return { url, expiresAt: new Date(Date.now() + signedSeconds * 1000).toISOString() };
    },
  };
}

function artifactPolicy(options: ArtifactPolicy): Required<ArtifactPolicy> {
  const maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
  const expiresInMs = options.expiresInMs ?? 7 * 24 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('artifact maxBytes must be positive');
  if (!Number.isSafeInteger(expiresInMs) || expiresInMs < 60_000) throw new RangeError('artifact expiresInMs must be at least one minute');
  return { maxBytes, expiresInMs, allowedContentTypes: options.allowedContentTypes ?? [] };
}
function validateUpload(data: Uint8Array, contentType: string, policy: Required<ArtifactPolicy>): void {
  if (data.byteLength > policy.maxBytes) throw new RangeError(`artifact exceeds ${policy.maxBytes} bytes`);
  if (policy.allowedContentTypes.length && !policy.allowedContentTypes.includes(contentType)) throw new TypeError(`artifact content type ${JSON.stringify(contentType)} is not allowed`);
}
function expiresAt(ms: number): string { return new Date(Date.now() + ms).toISOString() }
function cleanPrefix(value: string): string { const cleaned = value.replace(/^\/+/, '').replace(/\.{2}/g, ''); return cleaned.endsWith('/') ? cleaned : `${cleaned}/`; }
function safeSegment(value: string): string { return encodeURIComponent(required(value, 'artifact identity')); }
function required(value: string | undefined, label: string): string { const result = value?.trim(); if (!result) throw new TypeError(`${label} is required`); return result }
function requireAccess(ownerId: string, tenantId: string): void { required(ownerId, 'artifact ownerId'); required(tenantId, 'artifact tenantId') }
function requireHTTPS(value: string): void { if (new URL(value).protocol !== 'https:') throw new TypeError('artifact signed URL must use HTTPS') }
function parseS3Reference(reference: string): { bucket: string; key: string } { const url = new URL(reference); if (url.protocol !== 's3:') throw new TypeError('invalid S3 artifact reference'); return { bucket: url.hostname, key: url.pathname.slice(1) } }
function parseCloudinaryReference(reference: string): { cloudName: string; resourceType: string; publicId: string } { const url = new URL(reference); if (url.protocol !== 'cloudinary:') throw new TypeError('invalid Cloudinary artifact reference'); const [resourceType, ...rest] = url.pathname.slice(1).split('/'); if (!resourceType || !rest.length) throw new TypeError('invalid Cloudinary artifact reference'); return { cloudName: url.hostname, resourceType, publicId: rest.join('/') } }
