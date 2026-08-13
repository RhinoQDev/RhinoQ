import type { ArtifactUploadPart, ArtifactUploadSession, CreateArtifactUploadRequest } from './artifact-upload.js';
import type { MultipartPlan } from './artifact-storage.js';

export interface ArtifactUploadBrowserClient {
  createArtifactUpload(request: Omit<CreateArtifactUploadRequest,'ownerId'|'tenantId'>):Promise<{session:ArtifactUploadSession;plan:MultipartPlan}>;
  resumeArtifactUpload(id:string):Promise<ArtifactUploadSession>;
  signArtifactUploadPart(id:string,partNumber:number):Promise<{url:string;expiresAt:string}>;
  recordArtifactUploadPart(id:string,expectedVersion:number,part:ArtifactUploadPart):Promise<ArtifactUploadSession>;
  completeArtifactUpload(id:string,expectedVersion:number):Promise<{session:ArtifactUploadSession;artifact?:unknown}>;
}
export async function uploadArtifactFile(client:ArtifactUploadBrowserClient,file:Blob & {name?:string;type?:string},options:{sessionId?:string;taskId?:string;executionId?:string;artifactId?:string;checksumSha256?:string;name?:string;contentType?:string;concurrency?:number;onProgress?:(value:{uploadedBytes:number;totalBytes:number})=>void}={}):Promise<{session:ArtifactUploadSession;artifact?:unknown}>{
  if(!file||!Number.isSafeInteger(file.size)||file.size<1)throw new TypeError('upload file must be a non-empty Blob');const concurrency=options.concurrency??4;if(!Number.isInteger(concurrency)||concurrency<1||concurrency>8)throw new RangeError('direct upload concurrency must be 1..8');
  let session:ArtifactUploadSession,plan:MultipartPlan|undefined;if(options.sessionId){session=await client.resumeArtifactUpload(options.sessionId);}else{const created=await client.createArtifactUpload({name:options.name??file.name??'upload.bin',contentType:options.contentType??file.type??'application/octet-stream',sizeBytes:file.size,...(options.taskId?{taskId:options.taskId}:{}),...(options.executionId?{executionId:options.executionId}:{}),...(options.artifactId?{artifactId:options.artifactId}:{}),...(options.checksumSha256?{checksumSha256:options.checksumSha256}:{})});session=created.session;plan=created.plan;}
  const partSize=session.partSize??plan!.partSize,totalParts=Math.ceil(file.size/partSize),known=new Map(session.parts.map(part=>[part.partNumber,part]));let uploaded=[...known.values()].reduce((sum,part)=>sum+part.sizeBytes,0);options.onProgress?.({uploadedBytes:uploaded,totalBytes:file.size});let next=1;
  const completed:ArtifactUploadPart[]=[];await Promise.all(Array.from({length:Math.min(concurrency,totalParts)},async()=>{while(next<=totalParts){const partNumber=next++;if(known.has(partNumber))continue;const start=(partNumber-1)*partSize,end=Math.min(file.size,start+partSize),signed=await client.signArtifactUploadPart(session.id,partNumber),response=await fetch(signed.url,{method:'PUT',body:file.slice(start,end)});if(!response.ok)throw new Error(`artifact part ${partNumber} upload failed with ${response.status}`);const etag=response.headers.get('etag');if(!etag)throw new Error(`artifact part ${partNumber} response has no ETag`);completed.push({partNumber,etag,sizeBytes:end-start});uploaded+=end-start;options.onProgress?.({uploadedBytes:uploaded,totalBytes:file.size});}}));
  for(const part of completed.sort((a,b)=>a.partNumber-b.partNumber))session=await client.recordArtifactUploadPart(session.id,session.version,part);return client.completeArtifactUpload(session.id,session.version);
}
