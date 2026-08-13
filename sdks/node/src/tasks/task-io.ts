import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface RhinoQDownloadOptions { allowedHosts: string[]; maxBytes: number; timeoutMs?: number; maxRedirects?: number; headers?: Record<string,string> }
export interface RhinoQDownloadedFile { path: string; sourceUrl: string; sizeBytes: number; contentType?: string; checksumSha256: string }
export interface RhinoQTaskIO { download(url: string, outputPath: string, options: RhinoQDownloadOptions): Promise<RhinoQDownloadedFile> }

export function createRhinoQTaskIO(signal?:AbortSignal, fetchImpl:typeof fetch=fetch):RhinoQTaskIO{return Object.freeze({download:(url:string,path:string,options:RhinoQDownloadOptions)=>download(url,path,options,signal,fetchImpl)});}
async function download(rawUrl:string,outputPath:string,options:RhinoQDownloadOptions,parentSignal:AbortSignal|undefined,fetchImpl:typeof fetch):Promise<RhinoQDownloadedFile>{
  if(!Array.isArray(options?.allowedHosts)||options.allowedHosts.length<1)throw new TypeError('download allowedHosts must contain at least one trusted host');
  if(!Number.isSafeInteger(options.maxBytes)||options.maxBytes<1)throw new RangeError('download maxBytes must be a positive safe integer');
  const allowed=new Set(options.allowedHosts.map(host=>host.trim().toLowerCase()).filter(Boolean));let current=secureUrl(rawUrl,allowed),redirects=0;const maxRedirects=options.maxRedirects??3,timeoutMs=options.timeoutMs??5*60_000;
  if(!Number.isInteger(maxRedirects)||maxRedirects<0||maxRedirects>10)throw new RangeError('download maxRedirects must be 0..10');if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>24*60*60_000)throw new RangeError('download timeoutMs must be 1..86400000');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error('download timeout')),timeoutMs);timer.unref();const abort=()=>controller.abort(parentSignal?.reason);parentSignal?.addEventListener('abort',abort,{once:true});
  try{for(;;){const response=await fetchImpl(current,{method:'GET',headers:options.headers,redirect:'manual',signal:controller.signal});if(response.status>=300&&response.status<400){const location=response.headers.get('location');if(!location||redirects++>=maxRedirects)throw new Error('download redirect limit exceeded');current=secureUrl(new URL(location,current).href,allowed);continue;}if(!response.ok||!response.body)throw new Error(`download failed with HTTP ${response.status}`);const declared=Number(response.headers.get('content-length'));if(Number.isFinite(declared)&&declared>options.maxBytes)throw new RangeError(`download exceeds ${options.maxBytes} bytes`);let total=0;const hash=createHash('sha256'),meter=new Transform({transform(chunk,_encoding,callback){const bytes=Buffer.from(chunk);total+=bytes.length;if(total>options.maxBytes)return callback(new RangeError(`download exceeds ${options.maxBytes} bytes`));hash.update(bytes);callback(null,bytes);}});try{await pipeline(Readable.fromWeb(response.body as any),meter,createWriteStream(outputPath,{flags:'wx'}),{signal:controller.signal});}catch(error){await rm(outputPath,{force:true}).catch(()=>undefined);throw error;}const info=await stat(outputPath);return{path:outputPath,sourceUrl:current.href,sizeBytes:info.size,checksumSha256:hash.digest('hex'),...(response.headers.get('content-type')?{contentType:response.headers.get('content-type')!}:{})};}}
  finally{clearTimeout(timer);parentSignal?.removeEventListener('abort',abort);}
}
function secureUrl(value:string,allowed:Set<string>):URL{const url=new URL(value);if(url.protocol!=='https:')throw new TypeError('download URL must use HTTPS');if(url.username||url.password)throw new TypeError('download URL must not contain credentials');const host=url.hostname.toLowerCase();if(!allowed.has(host))throw new TypeError(`download host ${JSON.stringify(host)} is not allowed`);return url;}
