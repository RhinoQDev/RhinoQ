import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArtifactRetentionService, ArtifactUploadService, planMultipartUpload } from '../dist/index.js';

class MemoryStore {
  rows=new Map();
  async create(value){this.rows.set(value.id,value);return value;}
  async getForOwner(id,owner,tenant){const value=this.rows.get(id);if(!value||value.ownerId!==owner||value.tenantId!==tenant)throw new Error('not found');return value;}
  async save(value,expected){if(this.rows.get(value.id).version!==expected)throw new Error('version conflict');const next={...value,version:expected+1};this.rows.set(value.id,next);return next;}
  async claimExpired(){return [];}
}

test('adaptive multipart stays within memory and provider part-count bounds',()=>{
  const small=planMultipartUpload(100*1024*1024),huge=planMultipartUpload(100*1024*1024*1024);
  assert.ok(small.partSize>=5*1024*1024);assert.ok(small.partSize*small.queueSize<=small.memoryBudgetBytes);
  assert.ok(huge.estimatedParts<=9500);assert.ok(huge.partSize*huge.queueSize<=huge.memoryBudgetBytes);
});

test('durable direct upload records parts, verifies readback and registers one artifact',async()=>{
  const events=[],registered=[];const store=new MemoryStore();
  const provider={storage:{put(){}},resolve(){},direct:{name:'fake',async create(){return{uploadId:'provider-1',reference:'fake://private/key'};},async signPart({partNumber}){return{url:`https://upload.invalid/${partNumber}`,expiresAt:new Date(Date.now()+60000).toISOString()};},async complete(input){events.push(['complete',input.parts.length]);},async abort(){events.push(['abort']);},async verify(input){events.push(['verify']);return{sizeBytes:input.expectedSizeBytes,contentType:input.contentType};}}};
  const authorized=[];const service=new ArtifactUploadService(provider,store,async(_taskId,request)=>{registered.push(request);return request;},undefined,async(taskId,ownerId,tenantId)=>{authorized.push([taskId,ownerId,tenantId]);});
  let {session}=await service.create({ownerId:'owner',tenantId:'tenant',taskId:'task',executionId:'execution',name:'video.mp4',contentType:'video/mp4',sizeBytes:10*1024*1024,checksumSha256:'a'.repeat(64)});
  assert.match((await service.signPart(session.id,'owner','tenant',1)).url,/https:/);
  session=await service.recordPart(session.id,'owner','tenant',session.version,{partNumber:1,etag:'etag-1',sizeBytes:session.partSize});
  session=await service.recordPart(session.id,'owner','tenant',session.version,{partNumber:2,etag:'etag-2',sizeBytes:10*1024*1024-session.partSize});
  const completed=await service.complete(session.id,'owner','tenant',session.version);
  assert.equal(completed.session.state,'completed');assert.deepEqual(events,[['complete',2],['verify']]);assert.deepEqual(authorized,[['task','owner','tenant']]);assert.equal(registered[0].reference,'fake://private/key');assert.notEqual(registered[0].expiresAt,completed.session.expiresAt);
});

test('task-bound upload fails before provider access without checksum or authorization',async()=>{
  let creates=0;const store=new MemoryStore();const provider={storage:{put(){}},resolve(){},direct:{name:'fake',async create(){creates++;return{uploadId:'u',reference:'fake://key'};},async signPart(){},async listParts(){return[];},async complete(){},async abort(){},async verify(){return{sizeBytes:1};}}};
  const service=new ArtifactUploadService(provider,store,undefined,undefined,async()=>{throw new Error('not owner');});
  await assert.rejects(()=>service.create({ownerId:'o',taskId:'t',name:'x',contentType:'x/test',sizeBytes:1}),/checksumSha256/);
  await assert.rejects(()=>service.create({ownerId:'o',taskId:'t',name:'x',contentType:'x/test',sizeBytes:1,checksumSha256:'a'.repeat(64)}),/not owner/);
  assert.equal(creates,0);
});

test('unknown multipart completion fails closed as uncertain',async()=>{
  const store=new MemoryStore();const provider={storage:{put(){}},resolve(){},direct:{name:'fake',async create(){return{uploadId:'u',reference:'fake://key'};},async signPart(){return{url:'https://upload.invalid',expiresAt:new Date().toISOString()};},async complete(){throw new Error('lost response');},async abort(){},async verify(){return{sizeBytes:1};}}};
  const service=new ArtifactUploadService(provider,store);let {session}=await service.create({ownerId:'o',name:'x',contentType:'x/test',sizeBytes:1});session=await service.recordPart(session.id,'o','default',session.version,{partNumber:1,etag:'e',sizeBytes:1});
  await assert.rejects(()=>service.complete(session.id,'o','default',session.version),/uncertain/);assert.equal((await store.getForOwner(session.id,'o','default')).state,'uncertain');
});

test('uncertain completion reconciles by readback without completing provider twice',async()=>{
  const store=new MemoryStore();let completes=0,readable=false;const provider={storage:{put(){}},resolve(){},direct:{name:'fake',async create(){return{uploadId:'u',reference:'fake://key'};},async signPart(){return{url:'https://upload.invalid',expiresAt:new Date().toISOString()};},async listParts(){return[];},async complete(){completes++;readable=true;throw new Error('response lost');},async abort(){},async verify(input){if(!readable)throw new Error('missing');return{sizeBytes:input.expectedSizeBytes};}}};
  const service=new ArtifactUploadService(provider,store);let {session}=await service.create({ownerId:'o',name:'x',contentType:'x/test',sizeBytes:1});session=await service.recordPart(session.id,'o','default',session.version,{partNumber:1,etag:'e',sizeBytes:1});
  await assert.rejects(()=>service.complete(session.id,'o','default',session.version),/uncertain/);session=await service.resume(session.id,'o','default');const result=await service.complete(session.id,'o','default',session.version);assert.equal(result.session.state,'completed');assert.equal(completes,1);
});

test('retention requires preview and explicit deletion',async()=>{
  const deleted=[];const store={async previewExpired(){return[{id:'a',reference:'fake://a',expiresAt:new Date().toISOString()}];},async claimExpired(){return[{id:'a',reference:'fake://a',expiresAt:new Date().toISOString()}];},async complete(){deleted.push('metadata');},async fail(){}};
  const provider={storage:{put(){}},resolve(){},direct:{name:'fake',async delete({reference}){deleted.push(reference);}}};const retention=new ArtifactRetentionService(provider,store,'owner');
  assert.equal((await retention.preview()).length,1);await assert.rejects(()=>retention.sweep({delete:false}),/delete: true/);assert.deepEqual(await retention.sweep({delete:true}),{deleted:1,failed:0});assert.deepEqual(deleted,['fake://a','metadata']);
});
