import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { sha256Blob } from '../dist/browser.js';
import { planMultipartUpload } from '../dist/artifacts-entry.js';

const sizeBytes = Number(process.env.RHINOQ_LAB_BYTES ?? 256 * 1024 * 1024);
const sessions = Number(process.env.RHINOQ_LAB_SESSIONS ?? 1000);
if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || !Number.isInteger(sessions) || sessions < 1 || sessions > 100_000) throw new Error('invalid lab bounds');
const bytes = new Uint8Array(sizeBytes); for(let i=0;i<bytes.length;i+=4096)bytes[i]=i%251;
const manualStart=performance.now();const manual=createHash('sha256').update(bytes).digest('hex');const manualMs=performance.now()-manualStart;
const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
const rhinoStart=performance.now();const rhino=await sha256Blob(new Blob([bytes]),{chunkBytes:4*1024*1024});const rhinoMs=performance.now()-rhinoStart;
if(manual!==rhino)throw new Error('checksum parity failed');

const loadStart=performance.now();let plannedParts=0;
await Promise.all(Array.from({length:sessions},async(_,index)=>{const plan=planMultipartUpload(sizeBytes+(index%17)*1024*1024);plannedParts+=plan.estimatedParts;if(plan.estimatedParts>9500||plan.partSize*plan.queueSize>plan.memoryBudgetBytes)throw new Error('multipart bound violated');}));
const loadMs=performance.now()-loadStart;delay.disable();
const report={schemaVersion:1,kind:'artifact-production-lab',environment:{node:process.version,platform:process.platform},inputs:{sizeBytes,sessions},checksum:{parity:true,nodeNativeMs:Number(manualMs.toFixed(2)),rhinoIncrementalMs:Number(rhinoMs.toFixed(2)),note:'Native OpenSSL is a lower-bound comparison; RhinoQ pure-browser hashing yields between chunks.'},planningLoad:{sessions,elapsedMs:Number(loadMs.toFixed(2)),sessionsPerSecond:Number((sessions/(loadMs/1000)).toFixed(2)),plannedParts},eventLoop:{maxDelayMs:Number((delay.max/1e6).toFixed(2)),p99DelayMs:Number((delay.percentile(99)/1e6).toFixed(2))},claims:['correct checksum parity','bounded multipart planning','reproducible local evidence'],limitations:['synthetic memory data','not S3 throughput','not a claim that JavaScript hashing beats native OpenSSL']};
console.log(JSON.stringify(report,null,2));
