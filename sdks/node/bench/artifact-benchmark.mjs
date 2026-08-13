import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createS3CompatibleArtifactProvider, planMultipartUpload } from '../dist/artifacts-entry.js';

const sizeBytes = Number(process.env.RHINOQ_ARTIFACT_BENCH_BYTES ?? 256 * 1024 * 1024);
const chunkBytes = Number(process.env.RHINOQ_ARTIFACT_BENCH_CHUNK_BYTES ?? 1024 * 1024);
if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || !Number.isSafeInteger(chunkBytes) || chunkBytes < 4096) throw new Error('benchmark byte inputs must be positive safe integers');
let consumed = 0;
const provider = createS3CompatibleArtifactProvider({
  bucket: 'benchmark', maxBytes: sizeBytes,
  async putObject() {},
  async uploadStream({ body }) { for await (const chunk of body) consumed += chunk.byteLength; },
  signGetObject: () => 'https://benchmark.invalid/file',
  async verifyObject({ expectedSizeBytes, contentType }) { return { sizeBytes: expectedSizeBytes, contentType }; },
});
const before = process.memoryUsage().rss, started = performance.now();
await provider.storage.putStream({ id:'artifact-benchmark',taskId:'task-benchmark',executionId:'execution-benchmark',name:'large.bin',contentType:'application/octet-stream',sizeBytes,source:source(sizeBytes,chunkBytes) });
const elapsedMs = performance.now()-started, after=process.memoryUsage().rss;
if(consumed!==sizeBytes)throw new Error(`benchmark consumed ${consumed}; expected ${sizeBytes}`);
console.log(JSON.stringify({schemaVersion:1,kind:'synthetic-artifact-stream',sizeBytes,chunkBytes,elapsedMs:Number(elapsedMs.toFixed(2)),throughputMiBPerSecond:Number((sizeBytes/1024/1024/(elapsedMs/1000)).toFixed(2)),rssBeforeBytes:before,rssAfterBytes:after,rssDeltaBytes:after-before,multipartPlan:planMultipartUpload(sizeBytes),limitations:['in-memory sink','no provider/network latency','not production evidence']},null,2));
async function* source(total,chunk){let remaining=total;const value=new Uint8Array(chunk);createHash('sha256').update(value).digest();while(remaining){const length=Math.min(chunk,remaining);yield length===chunk?value:value.subarray(0,length);remaining-=length;}}
