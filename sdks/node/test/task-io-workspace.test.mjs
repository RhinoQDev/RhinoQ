import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRhinoQTaskIO, createTaskWorkspace } from '../dist/index.js';

test('safe download streams with a hard bound and checksum',async()=>{const root=await mkdtemp(join(tmpdir(),'rhinoq-io-test-')),target=join(root,'file.bin'),bytes=new TextEncoder().encode('streamed');try{const io=createRhinoQTaskIO(undefined,async()=>new Response(new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}}),{status:200,headers:{'content-length':String(bytes.length),'content-type':'application/octet-stream'}}));const result=await io.download('https://files.example/item',target,{allowedHosts:['files.example'],maxBytes:100});assert.equal(result.sizeBytes,bytes.length);assert.equal(result.checksumSha256,createHash('sha256').update(bytes).digest('hex'));}finally{await rm(root,{recursive:true,force:true});}});
test('safe download rejects protocol, host and oversized response before writing',async()=>{const io=createRhinoQTaskIO(undefined,async()=>new Response('x',{headers:{'content-length':'1000'}}));await assert.rejects(()=>io.download('http://files.example/x','unused',{allowedHosts:['files.example'],maxBytes:10}),/HTTPS/);await assert.rejects(()=>io.download('https://internal.example/x','unused',{allowedHosts:['files.example'],maxBytes:10}),/not allowed/);await assert.rejects(()=>io.download('https://files.example/x','unused',{allowedHosts:['files.example'],maxBytes:10}),/exceeds/);});
test('workspace prevents path escape, checks capacity and cleans idempotently',async()=>{const workspace=await createTaskWorkspace({minimumFreeBytes:1});const root=workspace.root;assert.equal(workspace.path('input.mp4').startsWith(root),true);await assert.rejects(async()=>workspace.path('../escape'),/escapes/);await workspace.assertCapacity(1);await workspace.cleanup();await workspace.cleanup();await assert.rejects(()=>access(root));});
