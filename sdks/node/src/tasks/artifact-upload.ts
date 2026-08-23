import { createHash, randomUUID } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import type { TaskArtifact, TaskArtifactCreateRequest } from '../gateway/types.js';
import type { SqlExecutor } from '../postgres/producer.js';
import type { MultipartPlan, RhinoQArtifactDirectUpload, RhinoQArtifactProvider } from './artifact-storage.js';
import { planMultipartUpload } from './artifact-storage.js';
import type { TaskMetrics } from '../observe/metrics.js';

export type ArtifactUploadState = 'uploading' | 'completing' | 'completed' | 'aborted' | 'expired' | 'uncertain';
export interface ArtifactUploadPart { partNumber: number; etag: string; sizeBytes: number }
export interface ArtifactUploadSession {
  id: string; tenantId: string; ownerId: string; taskId?: string; executionId?: string;
  artifactId: string; provider: string; providerUploadId: string; reference: string;
  name: string; contentType: string; sizeBytes: number; partSize: number;
  parts: ArtifactUploadPart[]; state: ArtifactUploadState; checksumSha256?: string;
  lastError?: string; artifactExpiresAt: string; expiresAt: string; version: number; createdAt: string; updatedAt: string;
}
export interface CreateArtifactUploadRequest {
  ownerId: string; tenantId?: string; taskId?: string; executionId?: string;
  artifactId?: string; name: string; contentType: string; sizeBytes: number;
  checksumSha256?: string; expiresInMs?: number; artifactExpiresInMs?: number; memoryBudgetBytes?: number;
  /** @internal Used by the worker path to recover exactly one persisted upload session. */
  sessionId?: string;
}
export interface ArtifactUploadWorkerFileRequest {
  path: string; taskId: string; executionId: string; artifactId: string;
  ownerId: string; tenantId: string; name: string; contentType: string;
  signal?: AbortSignal;
  onProgress?(value: { uploadedBytes: number; totalBytes: number }): Promise<void> | void;
}
export interface ArtifactUploadWorkerFileResult { session: ArtifactUploadSession }
export interface ArtifactUploadSessionStore {
  create(session: ArtifactUploadSession): Promise<ArtifactUploadSession>;
  getForOwner(id: string, ownerId: string, tenantId: string): Promise<ArtifactUploadSession>;
  save(session: ArtifactUploadSession, expectedVersion: number): Promise<ArtifactUploadSession>;
  claimExpired(limit: number, now?: Date): Promise<ArtifactUploadSession[]>;
}

export class PostgresArtifactUploadSessionStore implements ArtifactUploadSessionStore {
  constructor(private readonly sql: SqlExecutor) {}
  async create(session: ArtifactUploadSession): Promise<ArtifactUploadSession> {
    const row = await this.sql.query<UploadRow>(`INSERT INTO rhinoq_task.artifact_upload_sessions
      (id,tenant_id,owner_id,task_id,execution_id,artifact_id,provider,provider_upload_id,reference,name,content_type,size_bytes,part_size,parts,state,checksum_sha256,last_error,artifact_expires_at,expires_at,version,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`, uploadValues(session));
    return mapUpload(row.rows[0]!);
  }
  async getForOwner(id: string, ownerId: string, tenantId: string): Promise<ArtifactUploadSession> {
    const result = await this.sql.query<UploadRow>('SELECT * FROM rhinoq_task.artifact_upload_sessions WHERE id=$1 AND owner_id=$2 AND tenant_id=$3', [id, ownerId, tenantId]);
    if (!result.rows[0]) throw new Error('RHINOQ_ARTIFACT_UPLOAD_NOT_FOUND');
    return mapUpload(result.rows[0]);
  }
  async save(session: ArtifactUploadSession, expectedVersion: number): Promise<ArtifactUploadSession> {
    const result = await this.sql.query<UploadRow>(`UPDATE rhinoq_task.artifact_upload_sessions SET
      parts=$4::jsonb,state=$5,checksum_sha256=$6,last_error=$7,artifact_expires_at=$8,expires_at=$9,version=version+1,updated_at=clock_timestamp()
      WHERE id=$1 AND owner_id=$2 AND tenant_id=$3 AND version=$10 RETURNING *`,
      [session.id, session.ownerId, session.tenantId, JSON.stringify(session.parts), session.state, session.checksumSha256 ?? null, session.lastError ?? null, session.artifactExpiresAt, session.expiresAt, expectedVersion]);
    if (!result.rows[0]) throw new Error('RHINOQ_ARTIFACT_UPLOAD_VERSION_CONFLICT');
    return mapUpload(result.rows[0]);
  }
  async claimExpired(limit: number, now = new Date()): Promise<ArtifactUploadSession[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('upload cleanup limit must be 1..100');
    const result = await this.sql.query<UploadRow>(`UPDATE rhinoq_task.artifact_upload_sessions SET state='expired',version=version+1,updated_at=clock_timestamp()
      WHERE id IN (SELECT id FROM rhinoq_task.artifact_upload_sessions WHERE state IN ('uploading','uncertain') AND expires_at<=$1 ORDER BY expires_at,id FOR UPDATE SKIP LOCKED LIMIT $2)
      RETURNING *`, [now.toISOString(), limit]);
    return result.rows.map(mapUpload);
  }
}

export class ArtifactUploadService {
  private readonly direct: RhinoQArtifactDirectUpload;
  constructor(
    provider: RhinoQArtifactProvider,
    private readonly store: ArtifactUploadSessionStore,
    private readonly register?: (taskId: string, request: TaskArtifactCreateRequest) => Promise<TaskArtifact>,
    private readonly metrics?: TaskMetrics,
    private readonly authorizeTask?: (taskId: string, ownerId: string, tenantId: string) => Promise<void>,
  ) {
    if (!provider.direct) throw new TypeError('artifact provider does not support direct multipart upload');
    this.direct = provider.direct;
  }
  async create(request: CreateArtifactUploadRequest): Promise<{ session: ArtifactUploadSession; plan: MultipartPlan }> {
    const ownerId = required(request.ownerId, 'upload ownerId'), tenantId = request.tenantId?.trim() || 'default';
    const name = required(request.name, 'upload name'), contentType = required(request.contentType, 'upload contentType');
    if (!Number.isSafeInteger(request.sizeBytes) || request.sizeBytes < 1) throw new RangeError('upload sizeBytes must be a positive safe integer');
    if (request.checksumSha256 && !/^[0-9a-f]{64}$/.test(request.checksumSha256)) throw new TypeError('upload checksumSha256 must be lowercase SHA-256');
    if (request.taskId) {
      if (!this.authorizeTask) throw new Error('task-bound direct upload authorization is not configured');
      await this.authorizeTask(request.taskId.trim(), ownerId, tenantId);
    }
    const id = request.sessionId ? required(request.sessionId, 'upload sessionId') : randomUUID(), artifactId = request.artifactId?.trim() || `artifact-${createHash('sha256').update(`${tenantId}\0${ownerId}\0${name}\0${request.sizeBytes}`).digest('hex').slice(0, 32)}`;
    const plan = planMultipartUpload(request.sizeBytes, request.memoryBudgetBytes);
    const created = await this.direct.create({ sessionId: id, artifactId, name, contentType, sizeBytes: request.sizeBytes, partSize: plan.partSize, ownerId, tenantId });
    const now = new Date(), session: ArtifactUploadSession = { id, ownerId, tenantId, artifactId, provider: this.direct.name, providerUploadId: created.uploadId, reference: created.reference, name, contentType, sizeBytes: request.sizeBytes, partSize: plan.partSize, parts: [], state: 'uploading', artifactExpiresAt: new Date(now.getTime() + (request.artifactExpiresInMs ?? 7 * 24 * 60 * 60 * 1000)).toISOString(), expiresAt: new Date(now.getTime() + (request.expiresInMs ?? 24 * 60 * 60 * 1000)).toISOString(), version: 1, createdAt: now.toISOString(), updatedAt: now.toISOString(), ...(request.taskId?.trim() ? { taskId: request.taskId.trim() } : {}), ...(request.executionId?.trim() ? { executionId: request.executionId.trim() } : {}), ...(request.checksumSha256 ? { checksumSha256: request.checksumSha256 } : {}) };
    const saved=await this.store.create(session);this.metrics?.increment('rhinoq_artifact_upload_session_created_total',{provider:this.direct.name});return { session:saved, plan };
  }
  /**
   * Uploads a replayable local file through the existing persisted session.
   * A one-shot AsyncIterable cannot safely use this path because a new worker
   * could not reconstruct a missing part after a crash.
   */
  async uploadWorkerFile(input: ArtifactUploadWorkerFileRequest): Promise<ArtifactUploadWorkerFileResult> {
    if (!this.direct.uploadPart) throw new TypeError('artifact provider does not support worker multipart part uploads');
    const path = required(input.path, 'worker artifact file path');
    const ownerId = required(input.ownerId, 'worker artifact ownerId');
    const tenantId = required(input.tenantId, 'worker artifact tenantId');
    const taskId = required(input.taskId, 'worker artifact taskId');
    const executionId = required(input.executionId, 'worker artifact executionId');
    const artifactId = required(input.artifactId, 'worker artifactId');
    const name = required(input.name, 'worker artifact name');
    const contentType = required(input.contentType, 'worker artifact contentType');
    const before = await stat(path);
    if (!before.isFile() || before.size < 1) throw new TypeError('worker artifact file path must point to a non-empty regular file');
    const checksumSha256 = await sha256File(path, input.signal);
    assertStableFile(before, await stat(path));
    const sessionId = `worker-upload-${createHash('sha256').update(`${taskId}\0${executionId}\0${artifactId}`).digest('hex').slice(0, 48)}`;
    let session: ArtifactUploadSession;
    try {
      session = await this.resume(sessionId, ownerId, tenantId);
    } catch (error) {
      if (!isUploadNotFound(error)) throw error;
      try {
        session = (await this.create({ sessionId, ownerId, tenantId, taskId, executionId, artifactId, name, contentType, sizeBytes: before.size, checksumSha256 })).session;
      } catch (createError) {
        try { session = await this.resume(sessionId, ownerId, tenantId); } catch { throw createError; }
      }
    }
    assertWorkerSession(session, { taskId, executionId, artifactId, name, contentType, sizeBytes: before.size, checksumSha256 });
    if (session.state === 'completed') return { session };
    if (session.state === 'uncertain') return { session: (await this.complete(session.id, ownerId, tenantId, session.version, checksumSha256, { register: false })).session };
    session = await this.resume(session.id, ownerId, tenantId);
    const totalParts = Math.ceil(session.sizeBytes / session.partSize);
    let uploadedBytes = session.parts.reduce((total, part) => total + part.sizeBytes, 0);
    await input.onProgress?.({ uploadedBytes, totalBytes: session.sizeBytes });
    const known = new Set(session.parts.map((part) => part.partNumber));
    for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
      if (known.has(partNumber)) continue;
      input.signal?.throwIfAborted();
      const sizeBytes = expectedPartSize(session, partNumber);
      const body = await readWorkerFilePart(path, (partNumber - 1) * session.partSize, sizeBytes, input.signal);
      const uploaded = await this.direct.uploadPart({ uploadId: session.providerUploadId, reference: session.reference, partNumber, body, ...(input.signal ? { signal: input.signal } : {}) });
      const etag = required(uploaded.etag, 'worker multipart part etag');
      session = await this.recordPart(session.id, ownerId, tenantId, session.version, { partNumber, etag, sizeBytes });
      uploadedBytes += sizeBytes;
      await input.onProgress?.({ uploadedBytes, totalBytes: session.sizeBytes });
    }
    if (await sha256File(path, input.signal) !== checksumSha256) throw new Error('worker artifact file changed while multipart upload was running');
    assertStableFile(before, await stat(path));
    return { session: (await this.complete(session.id, ownerId, tenantId, session.version, checksumSha256, { register: false })).session };
  }
  async signPart(id: string, ownerId: string, tenantId: string, partNumber: number): Promise<{ url: string; expiresAt: string }> {
    const session = await this.store.getForOwner(id, ownerId, tenantId);
    ensureUploading(session); const maximum = Math.ceil(session.sizeBytes / session.partSize);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > maximum) throw new RangeError(`partNumber must be 1..${maximum}`);
    return this.direct.signPart({ uploadId: session.providerUploadId, reference: session.reference, partNumber });
  }
  async resume(id:string,ownerId:string,tenantId:string):Promise<ArtifactUploadSession>{let session=await this.store.getForOwner(id,ownerId,tenantId);if(session.state==='uncertain'||session.state==='completed')return session;ensureUploading(session);const providerParts=await this.direct.listParts({uploadId:session.providerUploadId,reference:session.reference});const parts=providerParts.sort((a,b)=>a.partNumber-b.partNumber);for(const part of parts)validatePart(session,part);if(JSON.stringify(parts)!==JSON.stringify(session.parts))session=await this.store.save({...session,parts},session.version);return session;}
  async recordPart(id: string, ownerId: string, tenantId: string, expectedVersion: number, part: ArtifactUploadPart): Promise<ArtifactUploadSession> {
    const session = await this.store.getForOwner(id, ownerId, tenantId); ensureUploading(session);
    validatePart(session, part);
    const parts = [...session.parts.filter((value) => value.partNumber !== part.partNumber), { ...part, etag: part.etag.trim() }].sort((a,b) => a.partNumber-b.partNumber);
    if (parts.reduce((total,value) => total+value.sizeBytes,0) > session.sizeBytes) throw new RangeError('recorded upload parts exceed declared size');
    const saved=await this.store.save({ ...session, parts }, expectedVersion);this.metrics?.increment('rhinoq_artifact_upload_part_recorded_total',{provider:this.direct.name});return saved;
  }
  async complete(id: string, ownerId: string, tenantId: string, expectedVersion: number, checksumSha256?: string, options: { register?: boolean } = {}): Promise<{ session: ArtifactUploadSession; artifact?: TaskArtifact }> {
    const register = options.register !== false;
    let session = await this.store.getForOwner(id, ownerId, tenantId);
    if (checksumSha256 !== undefined) {
      if (!/^[0-9a-f]{64}$/.test(checksumSha256)) throw new TypeError('upload checksumSha256 must be lowercase SHA-256');
      if (session.checksumSha256 && session.checksumSha256 !== checksumSha256) throw new Error('RHINOQ_ARTIFACT_UPLOAD_CHECKSUM_CONFLICT');
      if (!session.checksumSha256) session = await this.store.save({ ...session, checksumSha256 }, session.version);
      expectedVersion = session.version;
    }
    if (session.taskId && !session.checksumSha256) throw new TypeError('task-bound direct upload requires checksumSha256 before completion');
    if (session.state === 'uncertain') {
      if (session.version !== expectedVersion) throw new Error('RHINOQ_ARTIFACT_UPLOAD_VERSION_CONFLICT');
      try {
        const verified = await this.direct.verify({ reference: session.reference, expectedSizeBytes: session.sizeBytes, contentType: session.contentType });
        if (verified.sizeBytes !== session.sizeBytes) throw new Error('artifact upload readback size mismatch');
        const artifact = register && session.taskId && this.register ? await this.registerCompleted(session) : undefined;
        session = await this.store.save({ ...session, state: 'completed', lastError: undefined }, session.version);
        this.metrics?.increment('rhinoq_artifact_upload_completed_total',{provider:this.direct.name,reconciled:'true'});
        return { session, ...(artifact ? { artifact } : {}) };
      } catch (error) {
        throw Object.assign(new Error('artifact multipart completion remains uncertain; provider readback is not conclusive'), { cause: error, session });
      }
    }
    ensureUploading(session);
    const total = session.parts.reduce((sum, part) => sum + part.sizeBytes, 0);
    if (total !== session.sizeBytes) throw new RangeError(`upload parts total ${total}; expected ${session.sizeBytes}`);
    session = await this.store.save({ ...session, state: 'completing' }, expectedVersion);
    try {
      await this.direct.complete({ uploadId: session.providerUploadId, reference: session.reference, parts: session.parts });
      const verified = await this.direct.verify({ reference: session.reference, expectedSizeBytes: session.sizeBytes, contentType: session.contentType });
      if (verified.sizeBytes !== session.sizeBytes) throw new Error('artifact upload readback size mismatch');
      session = await this.store.save({ ...session, state: 'completed' }, session.version);
      this.metrics?.increment('rhinoq_artifact_upload_completed_total',{provider:this.direct.name});
      const artifact = register && session.taskId && this.register ? await this.registerCompleted(session) : undefined;
      return { session, ...(artifact ? { artifact } : {}) };
    } catch (error) {
      session = await this.store.save({ ...session, state: 'uncertain', lastError: safe(error) }, session.version);
      this.metrics?.increment('rhinoq_artifact_upload_uncertain_total',{provider:this.direct.name});
      throw Object.assign(new Error('artifact multipart completion is uncertain; verify before retry'), { session });
    }
  }
  private registerCompleted(session: ArtifactUploadSession): Promise<TaskArtifact> {
    return this.register!(session.taskId!, { id: session.artifactId, executionId: session.executionId, name: session.name, contentType: session.contentType, sizeBytes: session.sizeBytes, checksumSha256: session.checksumSha256!, reference: session.reference, expiresAt: session.artifactExpiresAt });
  }
  async abort(id: string, ownerId: string, tenantId: string, expectedVersion: number): Promise<ArtifactUploadSession> {
    const session = await this.store.getForOwner(id, ownerId, tenantId);
    if (session.state === 'completed') throw new Error('completed upload cannot be aborted');
    await this.direct.abort({ uploadId: session.providerUploadId, reference: session.reference });
    const saved=await this.store.save({ ...session, state: 'aborted' }, expectedVersion);this.metrics?.increment('rhinoq_artifact_upload_aborted_total',{provider:this.direct.name});return saved;
  }
  async cleanup(limit = 25): Promise<number> {
    const sessions = await this.store.claimExpired(limit);
    for (const session of sessions) await this.direct.abort({ uploadId: session.providerUploadId, reference: session.reference }).catch(() => undefined);
    return sessions.length;
  }
}

export interface ArtifactRetentionRecord { id: string; reference: string; expiresAt: string }
export interface ArtifactRetentionStore {
  previewExpired(limit: number, now?: Date): Promise<ArtifactRetentionRecord[]>;
  claimExpired(owner: string, limit: number, leaseMs: number, now?: Date): Promise<ArtifactRetentionRecord[]>;
  complete(id: string, owner: string): Promise<void>;
  fail(id: string, owner: string): Promise<void>;
}
export class PostgresArtifactRetentionStore implements ArtifactRetentionStore {
  constructor(private readonly sql: SqlExecutor) {}
  async previewExpired(limit:number,now=new Date()):Promise<ArtifactRetentionRecord[]>{validateCleanup(limit);const result=await this.sql.query<any>('SELECT id,reference,expires_at FROM rhinoq_task.artifacts WHERE cleanup_state=\'active\' AND expires_at<=$1 ORDER BY expires_at,id LIMIT $2',[now.toISOString(),limit]);return result.rows.map(retention);}
  async claimExpired(owner:string,limit:number,leaseMs:number,now=new Date()):Promise<ArtifactRetentionRecord[]>{validateCleanup(limit);required(owner,'cleanup owner');if(!Number.isInteger(leaseMs)||leaseMs<1000||leaseMs>3600000)throw new RangeError('cleanup leaseMs must be 1000..3600000');const result=await this.sql.query<any>(`UPDATE rhinoq_task.artifacts SET cleanup_state='leased',cleanup_owner=$1,cleanup_lease_until=$2,updated_at=clock_timestamp() WHERE id IN (SELECT id FROM rhinoq_task.artifacts WHERE expires_at<=$3 AND (cleanup_state='active' OR (cleanup_state='leased' AND cleanup_lease_until<=$3)) ORDER BY expires_at,id FOR UPDATE SKIP LOCKED LIMIT $4) RETURNING id,reference,expires_at`,[owner,new Date(now.getTime()+leaseMs).toISOString(),now.toISOString(),limit]);return result.rows.map(retention);}
  async complete(id:string,owner:string):Promise<void>{const result=await this.sql.query<{id:string}>(`WITH removed AS (DELETE FROM rhinoq_task.artifacts WHERE id=$1 AND cleanup_state='leased' AND cleanup_owner=$2 RETURNING id,task_id), advanced AS (UPDATE rhinoq_task.tasks SET version=version+1,updated_at=clock_timestamp() WHERE id IN (SELECT task_id FROM removed)) SELECT id FROM removed`,[id,owner]);if(!result.rows[0])throw new Error('RHINOQ_ARTIFACT_CLEANUP_LEASE_CONFLICT');}
  async fail(id:string,owner:string):Promise<void>{await this.sql.query("UPDATE rhinoq_task.artifacts SET cleanup_state='failed',cleanup_owner=NULL,cleanup_lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND cleanup_state='leased' AND cleanup_owner=$2",[id,owner]);}
}
export class ArtifactRetentionService {
  constructor(private readonly provider: RhinoQArtifactProvider,private readonly store:ArtifactRetentionStore,private readonly owner=`cleanup-${randomUUID()}`,private readonly metrics?:TaskMetrics){}
  preview(limit=25):Promise<ArtifactRetentionRecord[]>{return this.store.previewExpired(limit);}
  async sweep(options:{delete:boolean;limit?:number;leaseMs?:number}):Promise<{deleted:number;failed:number}>{if(options.delete!==true)throw new TypeError('artifact retention sweep requires delete: true; call preview() first');if(!this.provider.direct?.delete)throw new TypeError('artifact provider does not support deletion');const records=await this.store.claimExpired(this.owner,options.limit??25,options.leaseMs??60000);let deleted=0,failed=0;for(const record of records){try{await this.provider.direct.delete({reference:record.reference});await this.store.complete(record.id,this.owner);deleted++;this.metrics?.increment('rhinoq_artifact_retention_deleted_total',{provider:this.provider.direct.name});}catch{await this.store.fail(record.id,this.owner);failed++;this.metrics?.increment('rhinoq_artifact_retention_failed_total',{provider:this.provider.direct.name});}}return{deleted,failed};}
}

interface UploadRow { [key: string]: unknown }
function expectedPartSize(session: ArtifactUploadSession, partNumber: number): number {
  const maximum = Math.ceil(session.sizeBytes / session.partSize);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > maximum) throw new RangeError(`partNumber must be 1..${maximum}`);
  return partNumber === maximum ? session.sizeBytes - (partNumber - 1) * session.partSize : session.partSize;
}
function validatePart(session: ArtifactUploadSession, part: ArtifactUploadPart): void {
  if (!Number.isInteger(part.partNumber) || part.partNumber < 1 || !part.etag?.trim() || !Number.isSafeInteger(part.sizeBytes) || part.sizeBytes < 1) throw new TypeError('upload part requires partNumber, etag and sizeBytes');
  if (part.sizeBytes !== expectedPartSize(session, part.partNumber)) throw new RangeError(`upload part ${part.partNumber} size does not match the persisted multipart plan`);
}
function isUploadNotFound(error: unknown): boolean { return error instanceof Error && error.message === 'RHINOQ_ARTIFACT_UPLOAD_NOT_FOUND'; }
function assertStableFile(before: { size: number; mtimeMs: number }, after: { size: number; mtimeMs: number }): void {
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('worker artifact file changed while its checksum was calculated');
}
async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const file = await open(path, 'r');
  try {
    const buffer = new Uint8Array(1024 * 1024); let position = 0;
    for (;;) { signal?.throwIfAborted(); const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, position); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); position += bytesRead; }
  } finally { await file.close(); }
  return hash.digest('hex');
}
async function readWorkerFilePart(path: string, position: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
  const file = await open(path, 'r'); const body = new Uint8Array(length); let offset = 0;
  try {
    while (offset < length) { signal?.throwIfAborted(); const { bytesRead } = await file.read(body, offset, length - offset, position + offset); if (!bytesRead) throw new Error('worker artifact file ended before its expected multipart part'); offset += bytesRead; }
  } finally { await file.close(); }
  return body;
}
function assertWorkerSession(session: ArtifactUploadSession, input: { taskId: string; executionId: string; artifactId: string; name: string; contentType: string; sizeBytes: number; checksumSha256: string }): void {
  if (session.taskId !== input.taskId || session.executionId !== input.executionId || session.artifactId !== input.artifactId || session.name !== input.name || session.contentType !== input.contentType || session.sizeBytes !== input.sizeBytes || session.checksumSha256 !== input.checksumSha256) throw new Error('persisted worker artifact upload does not match the replayable file input');
}
function mapUpload(row: UploadRow): ArtifactUploadSession { const value = row as any; return { id:value.id,tenantId:value.tenant_id,ownerId:value.owner_id,artifactId:value.artifact_id,provider:value.provider,providerUploadId:value.provider_upload_id,reference:value.reference,name:value.name,contentType:value.content_type,sizeBytes:Number(value.size_bytes),partSize:Number(value.part_size),parts:value.parts,state:value.state,artifactExpiresAt:new Date(value.artifact_expires_at).toISOString(),expiresAt:new Date(value.expires_at).toISOString(),version:Number(value.version),createdAt:new Date(value.created_at).toISOString(),updatedAt:new Date(value.updated_at).toISOString(),...(value.task_id?{taskId:value.task_id}:{}),...(value.execution_id?{executionId:value.execution_id}:{}),...(value.checksum_sha256?{checksumSha256:value.checksum_sha256}:{}),...(value.last_error?{lastError:value.last_error}:{}) }; }
function uploadValues(session: ArtifactUploadSession): unknown[] { return [session.id,session.tenantId,session.ownerId,session.taskId??null,session.executionId??null,session.artifactId,session.provider,session.providerUploadId,session.reference,session.name,session.contentType,session.sizeBytes,session.partSize,JSON.stringify(session.parts),session.state,session.checksumSha256??null,session.lastError??null,session.artifactExpiresAt,session.expiresAt,session.version,session.createdAt,session.updatedAt]; }
function required(value: string | undefined,label:string):string { const result=value?.trim(); if(!result)throw new TypeError(`${label} is required`); return result; }
function ensureUploading(session: ArtifactUploadSession): void { if(session.state!=='uploading')throw new Error(`artifact upload is ${session.state}, not uploading`); }
function safe(error:unknown):string { return (error instanceof Error?error.message:String(error)).slice(0,2048); }
function retention(row:any):ArtifactRetentionRecord{return{id:row.id,reference:row.reference,expiresAt:new Date(row.expires_at).toISOString()};}
function validateCleanup(limit:number):void{if(!Number.isInteger(limit)||limit<1||limit>100)throw new RangeError('artifact cleanup limit must be 1..100');}
