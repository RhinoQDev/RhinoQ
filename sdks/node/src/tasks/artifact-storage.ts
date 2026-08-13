import type { TaskArtifactRecord } from '../gateway/types.js';
import type { RhinoQArtifactStorage } from './declaration.js';
import type { RhinoQArtifactStreamInput } from './declaration.js';
import { Readable } from 'node:stream';

export interface RhinoQArtifactAccess { url: string; expiresAt?: string }
export interface RhinoQArtifactProvider {
  storage: RhinoQArtifactStorage;
  resolve(artifact: TaskArtifactRecord, request: Request, ownerId: string, tenantId: string): Promise<RhinoQArtifactAccess>;
  direct?: RhinoQArtifactDirectUpload;
}
export interface RhinoQArtifactDirectUpload {
  name: string;
  create(input: { sessionId: string; artifactId: string; name: string; contentType: string; sizeBytes: number; partSize: number; ownerId: string; tenantId: string }): Promise<{ uploadId: string; reference: string }>;
  signPart(input: { uploadId: string; reference: string; partNumber: number }): Promise<{ url: string; expiresAt: string }>;
  listParts(input: { uploadId: string; reference: string }): Promise<Array<{ partNumber: number; etag: string; sizeBytes: number }>>;
  complete(input: { uploadId: string; reference: string; parts: Array<{ partNumber: number; etag: string }> }): Promise<void>;
  abort(input: { uploadId: string; reference: string }): Promise<void>;
  verify(input: { reference: string; expectedSizeBytes: number; contentType: string }): Promise<{ sizeBytes: number; contentType?: string }>;
  delete?(input: { reference: string }): Promise<void>;
}
export interface ArtifactPolicy { maxBytes?: number; allowedContentTypes?: string[]; expiresInMs?: number }

export interface S3CompatibleArtifactOptions extends ArtifactPolicy {
  bucket: string;
  prefix?: string;
  putObject(input: { bucket: string; key: string; body: Uint8Array; contentType: string; checksumSha256: string; metadata: Record<string, string> }): Promise<void>;
  /** Use the provider's managed multipart uploader here (for example @aws-sdk/lib-storage Upload). */
  uploadStream?(input: { bucket: string; key: string; body: AsyncIterable<Uint8Array>; contentType: string; sizeBytes?: number; metadata: Record<string, string>; signal?: AbortSignal }): Promise<void>;
  verifyObject?(input: { bucket: string; key: string; expectedSizeBytes?: number; contentType: string }): Promise<{ sizeBytes: number; contentType?: string }>;
  signGetObject(input: { bucket: string; key: string; expiresInSeconds: number; fileName: string; contentType: string }): Promise<string> | string;
  signedUrlExpiresInSeconds?: number;
}

export interface AwsS3ArtifactOptions extends ArtifactPolicy {
  bucket: string;
  prefix?: string;
  /** Existing S3Client. When omitted RhinoQ creates one from clientConfig. */
  client?: unknown;
  clientConfig?: Record<string, unknown>;
  signedUrlExpiresInSeconds?: number;
  multipart?: { partSize?: number; queueSize?: number };
  /** Defaults to true. A HEAD mismatch fails before artifact metadata is registered. */
  readback?: boolean;
}

export interface MultipartPlan { partSize: number; queueSize: number; estimatedParts: number; memoryBudgetBytes: number }
export function planMultipartUpload(sizeBytes: number | undefined, memoryBudgetBytes = 64 * 1024 * 1024): MultipartPlan {
  if (sizeBytes !== undefined && (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)) throw new RangeError('multipart sizeBytes must be a non-negative safe integer');
  if (!Number.isSafeInteger(memoryBudgetBytes) || memoryBudgetBytes < 10 * 1024 * 1024) throw new RangeError('multipart memory budget must be at least 10 MiB');
  const minimum = 5 * 1024 * 1024;
  const required = sizeBytes ? Math.ceil(sizeBytes / 9_500) : 16 * 1024 * 1024;
  const partSize = Math.max(minimum, Math.ceil(required / minimum) * minimum);
  const queueSize = Math.max(1, Math.min(8, Math.floor(memoryBudgetBytes / partSize)));
  return { partSize, queueSize, estimatedParts: sizeBytes ? Math.ceil(sizeBytes / partSize) : 0, memoryBudgetBytes };
}

/**
 * Batteries-included AWS S3 adapter. AWS packages remain optional and are
 * loaded only when this factory is called.
 */
export async function createAwsS3ArtifactProvider(options: AwsS3ArtifactOptions): Promise<RhinoQArtifactProvider> {
  const clientS3 = await optionalImport('@aws-sdk/client-s3');
  const storage = await optionalImport('@aws-sdk/lib-storage');
  const presigner = await optionalImport('@aws-sdk/s3-request-presigner');
  const S3Client = callable(clientS3.S3Client, 'S3Client');
  const PutObjectCommand = callable(clientS3.PutObjectCommand, 'PutObjectCommand');
  const GetObjectCommand = callable(clientS3.GetObjectCommand, 'GetObjectCommand');
  const HeadObjectCommand = callable(clientS3.HeadObjectCommand, 'HeadObjectCommand');
  const CreateMultipartUploadCommand = callable(clientS3.CreateMultipartUploadCommand, 'CreateMultipartUploadCommand');
  const UploadPartCommand = callable(clientS3.UploadPartCommand, 'UploadPartCommand');
  const CompleteMultipartUploadCommand = callable(clientS3.CompleteMultipartUploadCommand, 'CompleteMultipartUploadCommand');
  const ListPartsCommand = callable(clientS3.ListPartsCommand, 'ListPartsCommand');
  const AbortMultipartUploadCommand = callable(clientS3.AbortMultipartUploadCommand, 'AbortMultipartUploadCommand');
  const DeleteObjectCommand = callable(clientS3.DeleteObjectCommand, 'DeleteObjectCommand');
  const Upload = callable(storage.Upload, 'Upload');
  const getSignedUrl = functionExport(presigner.getSignedUrl, 'getSignedUrl');
  const client = options.client ?? new S3Client(options.clientConfig ?? {});
  const configuredPartSize = options.multipart?.partSize;
  const configuredQueueSize = options.multipart?.queueSize;
  if (configuredPartSize !== undefined && (!Number.isSafeInteger(configuredPartSize) || configuredPartSize < 5 * 1024 * 1024)) throw new RangeError('S3 multipart partSize must be at least 5 MiB');
  if (configuredQueueSize !== undefined && (!Number.isInteger(configuredQueueSize) || configuredQueueSize < 1 || configuredQueueSize > 32)) throw new RangeError('S3 multipart queueSize must be 1..32');
  const provider = createS3CompatibleArtifactProvider({
    ...options,
    async putObject({ bucket, key, body, contentType, checksumSha256, metadata }) {
      await (client as { send(command: unknown): Promise<unknown> }).send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, ChecksumSHA256: Buffer.from(checksumSha256, 'hex').toString('base64'), Metadata: metadata }));
    },
    async uploadStream({ bucket, key, body, contentType, metadata, signal, sizeBytes }) {
      const plan = planMultipartUpload(sizeBytes);
      const upload = new Upload({ client, params: { Bucket: bucket, Key: key, Body: Readable.from(body), ContentType: contentType, Metadata: metadata }, partSize: configuredPartSize ?? plan.partSize, queueSize: configuredQueueSize ?? plan.queueSize, leavePartsOnError: false });
      const abort = () => upload.abort();
      signal?.addEventListener('abort', abort, { once: true });
      try { await upload.done(); } finally { signal?.removeEventListener('abort', abort); }
    },
    ...(options.readback === false ? {} : { async verifyObject({ bucket, key, expectedSizeBytes, contentType }) {
      const head = await (client as { send(command: unknown): Promise<{ ContentLength?: number; ContentType?: string }> }).send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      if (!Number.isSafeInteger(head.ContentLength) || head.ContentLength! < 0) throw new TypeError('S3 HEAD response has no valid ContentLength');
      if (expectedSizeBytes !== undefined && head.ContentLength !== expectedSizeBytes) throw new Error(`S3 readback size mismatch: expected ${expectedSizeBytes}, got ${head.ContentLength}`);
      if (head.ContentType && head.ContentType !== contentType) throw new Error(`S3 readback content type mismatch: expected ${contentType}, got ${head.ContentType}`);
      return { sizeBytes: head.ContentLength!, ...(head.ContentType ? { contentType: head.ContentType } : {}) };
    } }),
    signGetObject: ({ bucket, key, expiresInSeconds, fileName, contentType }) => getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentType: contentType, ResponseContentDisposition: `attachment; filename="${fileName.replace(/["\\]/g, '_')}"` }), { expiresIn: expiresInSeconds }) as Promise<string>,
  });
  const bucket = required(options.bucket, 'S3 bucket'), prefix = cleanPrefix(options.prefix ?? 'rhinoq/');
  const parse = (reference: string) => { const value = parseS3Reference(reference); if (value.bucket !== bucket || !value.key.startsWith(prefix)) throw new TypeError('direct upload reference is outside configured S3 namespace'); return value; };
  provider.direct = {
    name: 's3',
    async create(input) {
      const key = `${prefix}${safeSegment(input.tenantId)}/${safeSegment(input.ownerId)}/${safeSegment(input.artifactId)}/${encodeURIComponent(input.name)}`;
      const result = await (client as { send(command: unknown): Promise<{ UploadId?: string }> }).send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: input.contentType, Metadata: { 'rhinoq-session-id': input.sessionId, 'rhinoq-artifact-id': input.artifactId } }));
      if (!result.UploadId) throw new Error('S3 did not return multipart UploadId');
      return { uploadId: result.UploadId, reference: `s3://${bucket}/${key}` };
    },
    async signPart(input) { const { key } = parse(input.reference); const seconds = 900; const url = await getSignedUrl(client, new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: input.uploadId, PartNumber: input.partNumber }), { expiresIn: seconds }); requireHTTPS(url); return { url, expiresAt: new Date(Date.now()+seconds*1000).toISOString() }; },
    async listParts(input) { const { key }=parse(input.reference);const parts=[];let marker: number|undefined;do{const page=await (client as {send(command:unknown):Promise<{Parts?:Array<{PartNumber?:number;ETag?:string;Size?:number}>;IsTruncated?:boolean;NextPartNumberMarker?:number}>}).send(new ListPartsCommand({Bucket:bucket,Key:key,UploadId:input.uploadId,...(marker?{PartNumberMarker:marker}:{})}));for(const part of page.Parts??[]){if(Number.isInteger(part.PartNumber)&&part.ETag&&Number.isSafeInteger(part.Size))parts.push({partNumber:part.PartNumber!,etag:part.ETag,sizeBytes:part.Size!});}marker=page.IsTruncated?page.NextPartNumberMarker:undefined;}while(marker);return parts; },
    async complete(input) { const { key } = parse(input.reference); await (client as { send(command: unknown): Promise<unknown> }).send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: input.uploadId, MultipartUpload: { Parts: input.parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })) } })); },
    async abort(input) { const { key } = parse(input.reference); await (client as { send(command: unknown): Promise<unknown> }).send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: input.uploadId })); },
    async verify(input) { const { key } = parse(input.reference); const head = await (client as { send(command: unknown): Promise<{ ContentLength?: number; ContentType?: string }> }).send(new HeadObjectCommand({ Bucket: bucket, Key: key })); if (!Number.isSafeInteger(head.ContentLength)) throw new TypeError('S3 HEAD has no ContentLength'); if(head.ContentLength!==input.expectedSizeBytes)throw new Error('S3 direct upload size mismatch'); if(head.ContentType&&head.ContentType!==input.contentType)throw new Error('S3 direct upload content type mismatch'); return { sizeBytes:head.ContentLength!,...(head.ContentType?{contentType:head.ContentType}:{}) }; },
    async delete(input) { const { key } = parse(input.reference); await (client as { send(command: unknown): Promise<unknown> }).send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); },
  };
  return provider;
}

export async function createAwsS3ArtifactProviderFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<RhinoQArtifactProvider> {
  const bucket = required(env.RHINOQ_ARTIFACT_BUCKET, 'RHINOQ_ARTIFACT_BUCKET');
  const maxBytes = env.RHINOQ_ARTIFACT_MAX_BYTES === undefined ? 10 * 1024 * 1024 * 1024 : positiveInteger(env.RHINOQ_ARTIFACT_MAX_BYTES, 'RHINOQ_ARTIFACT_MAX_BYTES');
  const allowedContentTypes = env.RHINOQ_ARTIFACT_CONTENT_TYPES?.split(',').map((value) => value.trim()).filter(Boolean);
  return createAwsS3ArtifactProvider({
    bucket,
    prefix: env.RHINOQ_ARTIFACT_PREFIX ?? 'rhinoq/',
    maxBytes,
    ...(allowedContentTypes?.length ? { allowedContentTypes } : {}),
    clientConfig: {
      ...(env.RHINOQ_ARTIFACT_REGION ? { region: env.RHINOQ_ARTIFACT_REGION } : {}),
      ...(env.RHINOQ_ARTIFACT_ENDPOINT ? { endpoint: env.RHINOQ_ARTIFACT_ENDPOINT } : {}),
      ...(env.RHINOQ_ARTIFACT_FORCE_PATH_STYLE ? { forcePathStyle: env.RHINOQ_ARTIFACT_FORCE_PATH_STYLE === 'true' } : {}),
    },
  });
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
        await verifyS3(options, bucket, key, input.data.byteLength, input.contentType);
        return { reference: `s3://${bucket}/${key}`, expiresAt: expiresAt(policy.expiresInMs) };
      },
      ...(options.uploadStream ? { async putStream(input: RhinoQArtifactStreamInput) {
        validateStream(input, policy);
        const key = `${prefix}${safeSegment(input.taskId)}/${safeSegment(input.id)}/${encodeURIComponent(input.name)}`;
        await options.uploadStream!({ bucket, key, body: limitStream(input.source, policy.maxBytes, input.signal), contentType: input.contentType, ...(input.sizeBytes === undefined ? {} : { sizeBytes: input.sizeBytes }), metadata: { 'rhinoq-task-id': input.taskId, 'rhinoq-execution-id': input.executionId }, ...(input.signal ? { signal: input.signal } : {}) });
        await verifyS3(options, bucket, key, input.sizeBytes, input.contentType);
        return { reference: `s3://${bucket}/${key}`, expiresAt: expiresAt(policy.expiresInMs) };
      } } : {}),
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
  /** Optional provider-native chunked/resumable uploader for large media. */
  uploadStream?(input: { publicId: string; source: AsyncIterable<Uint8Array>; contentType: string; fileName: string; sizeBytes?: number; context: Record<string, string>; signal?: AbortSignal }): Promise<{ publicId: string; resourceType?: string }>;
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
      ...(options.uploadStream ? { async putStream(input: RhinoQArtifactStreamInput) {
        validateStream(input, policy);
        const expected = `${folder}/${safeSegment(input.taskId)}/${safeSegment(input.id)}`;
        const uploaded = await options.uploadStream!({ publicId: expected, source: limitStream(input.source, policy.maxBytes, input.signal), contentType: input.contentType, fileName: input.name, ...(input.sizeBytes === undefined ? {} : { sizeBytes: input.sizeBytes }), context: { rhinoq_task_id: input.taskId, rhinoq_execution_id: input.executionId }, ...(input.signal ? { signal: input.signal } : {}) });
        if (uploaded.publicId !== expected) throw new TypeError('Cloudinary stream upload returned a different publicId');
        return { reference: `cloudinary://${cloudName}/${uploaded.resourceType ?? 'video'}/${uploaded.publicId}`, expiresAt: expiresAt(policy.expiresInMs) };
      } } : {}),
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
function validateStream(input: RhinoQArtifactStreamInput, policy: Required<ArtifactPolicy>): void {
  if (input.sizeBytes !== undefined && input.sizeBytes > policy.maxBytes) throw new RangeError(`artifact exceeds ${policy.maxBytes} bytes`);
  if (policy.allowedContentTypes.length && !policy.allowedContentTypes.includes(input.contentType)) throw new TypeError(`artifact content type ${JSON.stringify(input.contentType)} is not allowed`);
}
async function* limitStream(source: AsyncIterable<Uint8Array>, maxBytes: number, signal?: AbortSignal): AsyncIterable<Uint8Array> {
  let total = 0;
  for await (const chunk of source) {
    if (signal?.aborted) throw signal.reason ?? new Error('artifact upload aborted');
    total += chunk.byteLength;
    if (total > maxBytes) throw new RangeError(`artifact exceeds ${maxBytes} bytes`);
    yield chunk;
  }
}
function expiresAt(ms: number): string { return new Date(Date.now() + ms).toISOString() }
function cleanPrefix(value: string): string { const cleaned = value.replace(/^\/+/, '').replace(/\.{2}/g, ''); return cleaned.endsWith('/') ? cleaned : `${cleaned}/`; }
function safeSegment(value: string): string { return encodeURIComponent(required(value, 'artifact identity')); }
function required(value: string | undefined, label: string): string { const result = value?.trim(); if (!result) throw new TypeError(`${label} is required`); return result }
function requireAccess(ownerId: string, tenantId: string): void { required(ownerId, 'artifact ownerId'); required(tenantId, 'artifact tenantId') }
function requireHTTPS(value: string): void { if (new URL(value).protocol !== 'https:') throw new TypeError('artifact signed URL must use HTTPS') }
function parseS3Reference(reference: string): { bucket: string; key: string } { const url = new URL(reference); if (url.protocol !== 's3:') throw new TypeError('invalid S3 artifact reference'); return { bucket: url.hostname, key: url.pathname.slice(1) } }
function parseCloudinaryReference(reference: string): { cloudName: string; resourceType: string; publicId: string } { const url = new URL(reference); if (url.protocol !== 'cloudinary:') throw new TypeError('invalid Cloudinary artifact reference'); const [resourceType, ...rest] = url.pathname.slice(1).split('/'); if (!resourceType || !rest.length) throw new TypeError('invalid Cloudinary artifact reference'); return { cloudName: url.hostname, resourceType, publicId: rest.join('/') } }
async function optionalImport(specifier: string): Promise<Record<string, unknown>> {
  try { return await import(specifier) as Record<string, unknown>; }
  catch (error) { throw new Error(`createAwsS3ArtifactProvider requires ${specifier}; install @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner`, { cause: error }); }
}
function callable(value: unknown, label: string): new (...args: any[]) => any {
  if (typeof value !== 'function') throw new TypeError(`AWS SDK export ${label} is unavailable`);
  return value as new (...args: any[]) => any;
}
function functionExport(value: unknown, label: string): (...args: any[]) => any {
  if (typeof value !== 'function') throw new TypeError(`AWS SDK export ${label} is unavailable`);
  return value as (...args: any[]) => any;
}
function positiveInteger(value: string, label: string): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 1) throw new RangeError(`${label} must be a positive integer`); return parsed; }
async function verifyS3(options: S3CompatibleArtifactOptions, bucket: string, key: string, expectedSizeBytes: number | undefined, contentType: string): Promise<void> {
  if (!options.verifyObject) return;
  const result = await options.verifyObject({ bucket, key, ...(expectedSizeBytes === undefined ? {} : { expectedSizeBytes }), contentType });
  if (!Number.isSafeInteger(result.sizeBytes) || result.sizeBytes < 0) throw new TypeError('artifact readback returned an invalid size');
}
