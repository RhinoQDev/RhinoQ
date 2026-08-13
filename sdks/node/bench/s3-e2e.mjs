import { randomUUID } from 'node:crypto';
import { createAwsS3ArtifactProviderFromEnv, planMultipartUpload } from '../dist/artifacts-entry.js';

const sizeBytes = 11 * 1024 * 1024 + 17;
const provider = await createAwsS3ArtifactProviderFromEnv(process.env);
if (!provider.direct?.delete) throw new Error('configured provider has no direct multipart/delete support');
const id = `e2e-${randomUUID()}`, plan = planMultipartUpload(sizeBytes, 16 * 1024 * 1024);
let created, completed = false;
try {
  created = await provider.direct.create({ sessionId:id, artifactId:id, name:'probe.bin', contentType:'application/octet-stream', sizeBytes, partSize:plan.partSize, ownerId:'e2e', tenantId:'e2e' });
  const parts=[];
  for(let start=0,partNumber=1;start<sizeBytes;start+=plan.partSize,partNumber++){
    const length=Math.min(plan.partSize,sizeBytes-start), body=new Uint8Array(length);body.fill(partNumber%251);
    const signed=await provider.direct.signPart({uploadId:created.uploadId,reference:created.reference,partNumber});
    const response=await fetch(signed.url,{method:'PUT',body});
    if(!response.ok)throw new Error(`S3 part ${partNumber} failed: ${response.status}`);
    const etag=response.headers.get('etag');if(!etag)throw new Error(`S3 part ${partNumber} returned no ETag`);
    parts.push({partNumber,etag,sizeBytes:length});
  }
  const listed=await provider.direct.listParts({uploadId:created.uploadId,reference:created.reference});
  if(listed.length!==parts.length)throw new Error(`S3 listed ${listed.length} parts; expected ${parts.length}`);
  await provider.direct.complete({uploadId:created.uploadId,reference:created.reference,parts});completed=true;
  const verified=await provider.direct.verify({reference:created.reference,expectedSizeBytes:sizeBytes,contentType:'application/octet-stream'});
  console.log(JSON.stringify({ok:true,sizeBytes,parts:parts.length,readbackBytes:verified.sizeBytes,cleanup:'deleted'},null,2));
} finally {
  if(created){if(!completed)await provider.direct.abort({uploadId:created.uploadId,reference:created.reference}).catch(()=>undefined);await provider.direct.delete({reference:created.reference}).catch(()=>undefined);}
}
