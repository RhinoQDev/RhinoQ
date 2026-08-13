import { randomUUID } from 'node:crypto';
import { createAwsS3ArtifactProviderFromEnv, planMultipartUpload } from '../dist/artifacts-entry.js';

const sizeBytes=16*1024*1024+31,id=`fault-${randomUUID()}`,plan=planMultipartUpload(sizeBytes,16*1024*1024);
const first=await createAwsS3ArtifactProviderFromEnv(process.env);if(!first.direct?.delete)throw new Error('S3 direct provider required');let created,completed=false;
try{
  created=await first.direct.create({sessionId:id,artifactId:id,name:'restart.bin',contentType:'application/octet-stream',sizeBytes,partSize:plan.partSize,ownerId:'fault',tenantId:'fault'});
  const parts=[];const upload=async(provider,partNumber,start)=>{const length=Math.min(plan.partSize,sizeBytes-start),signed=await provider.direct.signPart({uploadId:created.uploadId,reference:created.reference,partNumber}),response=await fetch(signed.url,{method:'PUT',body:new Uint8Array(length).fill(partNumber)});if(!response.ok)throw new Error(`part ${partNumber}: ${response.status}`);const etag=response.headers.get('etag');if(!etag)throw new Error('missing ETag');return{partNumber,etag,sizeBytes:length};};
  parts.push(await upload(first,1,0));
  const restarted=await createAwsS3ArtifactProviderFromEnv(process.env);const recovered=await restarted.direct.listParts({uploadId:created.uploadId,reference:created.reference});if(recovered.length!==1)throw new Error('restart reconciliation failed');
  for(let start=plan.partSize,number=2;start<sizeBytes;start+=plan.partSize,number++)parts.push(await upload(restarted,number,start));
  await restarted.direct.complete({uploadId:created.uploadId,reference:created.reference,parts});completed=true;const verified=await restarted.direct.verify({reference:created.reference,expectedSizeBytes:sizeBytes,contentType:'application/octet-stream'});
  console.log(JSON.stringify({ok:true,scenario:'process-restart-after-first-part',recoveredParts:recovered.length,totalParts:parts.length,readbackBytes:verified.sizeBytes,cleanup:'deleted'},null,2));
}finally{if(created){if(!completed)await first.direct.abort({uploadId:created.uploadId,reference:created.reference}).catch(()=>undefined);await first.direct.delete({reference:created.reference}).catch(()=>undefined);}}
