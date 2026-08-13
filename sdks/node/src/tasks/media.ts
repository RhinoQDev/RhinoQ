import { spawn } from 'node:child_process';
import { stat, statfs } from 'node:fs/promises';
import type { RhinoQTaskOutputHelpers } from './declaration.js';
import type { TaskArtifact } from '../gateway/types.js';

export interface RhinoQMediaContext {
  transcode(inputPath: string, outputPath: string, options?: RhinoQTranscodeOptions): Promise<TaskArtifact>;
  thumbnail(inputPath: string, outputPath: string, options?: RhinoQThumbnailOptions): Promise<TaskArtifact>;
}
export interface RhinoQTranscodeOptions { videoCodec?: 'libx264' | 'libx265' | 'copy'; audioCodec?: 'aac' | 'copy'; preset?: 'fast' | 'balanced' | 'quality'; timeoutMs?: number }
export interface RhinoQThumbnailOptions { atSeconds?: number; width?: number; timeoutMs?: number }
export interface RhinoQMediaRuntimeReport { ffmpegPath: string; version: string; requiredEncoders: string[]; missingEncoders: string[]; workDirectory: string; freeBytes: number; minimumFreeBytes: number; ready: boolean }

/** Startup/readiness check for the exact FFmpeg binary, codecs and worker volume. */
export async function inspectRhinoQMediaRuntime(options: { ffmpegPath?: string; requiredEncoders?: string[]; workDirectory?: string; minimumFreeBytes?: number } = {}): Promise<RhinoQMediaRuntimeReport> {
  const ffmpegPath = options.ffmpegPath ?? process.env.RHINOQ_FFMPEG_PATH ?? 'ffmpeg';
  const requiredEncoders = options.requiredEncoders ?? ['libx264', 'aac'];
  const workDirectory = options.workDirectory ?? process.env.RHINOQ_MEDIA_WORK_DIR ?? '/work';
  const minimumFreeBytes = options.minimumFreeBytes ?? 10 * 1024 * 1024 * 1024;
  if (!Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes < 1) throw new RangeError('media minimumFreeBytes must be a positive safe integer');
  const [versionOutput, encoderOutput, filesystem] = await Promise.all([capture(ffmpegPath, ['-version']), capture(ffmpegPath, ['-hide_banner', '-encoders']), statfs(workDirectory)]);
  const missingEncoders = requiredEncoders.filter((codec) => !new RegExp(`\\b${escapeRegExp(codec)}\\b`).test(encoderOutput));
  const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  return { ffmpegPath, version: versionOutput.split(/\r?\n/, 1)[0] ?? '', requiredEncoders, missingEncoders, workDirectory, freeBytes, minimumFreeBytes, ready: missingEncoders.length === 0 && freeBytes >= minimumFreeBytes };
}

export function createRhinoQMediaContext(output: RhinoQTaskOutputHelpers, signal?: AbortSignal, ffmpegPath = process.env.RHINOQ_FFMPEG_PATH || 'ffmpeg'): RhinoQMediaContext {
  return Object.freeze({
    async transcode(inputPath: string, outputPath: string, options: RhinoQTranscodeOptions = {}) {
      const codec = options.videoCodec ?? 'libx264', audio = options.audioCodec ?? 'aac';
      const preset = options.preset === 'fast' ? 'veryfast' : options.preset === 'quality' ? 'slow' : 'medium';
      const args = ['-nostdin','-hide_banner','-loglevel','error','-y','-i',required(inputPath,'media input'),'-c:v',codec];
      if (codec !== 'copy') args.push('-preset',preset);
      args.push('-c:a',audio,required(outputPath,'media output'));
      await run(ffmpegPath,args,signal,options.timeoutMs);
      await verifyOutput(outputPath);
      return output.video(outputPath);
    },
    async thumbnail(inputPath: string, outputPath: string, options: RhinoQThumbnailOptions = {}) {
      const at = options.atSeconds ?? 0, width = options.width ?? 1280;
      if (!Number.isFinite(at) || at < 0) throw new RangeError('thumbnail atSeconds must be non-negative');
      if (!Number.isInteger(width) || width < 16 || width > 16_384) throw new RangeError('thumbnail width must be 16..16384');
      await run(ffmpegPath,['-nostdin','-hide_banner','-loglevel','error','-y','-ss',String(at),'-i',required(inputPath,'media input'),'-frames:v','1','-vf',`scale=${width}:-2`,required(outputPath,'media output')],signal,options.timeoutMs);
      await verifyOutput(outputPath);
      return output.file(outputPath);
    },
  });
}

async function run(command:string,args:string[],signal?:AbortSignal,timeoutMs=30*60*1000):Promise<void>{
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>24*60*60*1000)throw new RangeError('media timeoutMs must be 1..86400000');
  if(signal?.aborted)throw signal.reason??new Error('media operation aborted');
  await new Promise<void>((resolve,reject)=>{
    const child=spawn(command,args,{stdio:['ignore','ignore','pipe'],windowsHide:true}); let stderr='',settled=false;
    const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve();};
    child.stderr.on('data',(chunk)=>{stderr=(stderr+String(chunk)).slice(-8192);});
    child.on('error',(error)=>finish(error)); child.on('exit',(code,term)=>code===0?finish():finish(new Error(`ffmpeg failed (${code??term??'unknown'}): ${stderr.trim()}`)));
    const abort=()=>{child.kill('SIGTERM');setTimeout(()=>{if(!settled)child.kill('SIGKILL');},2000).unref();finish(signal?.reason instanceof Error?signal.reason:new Error('media operation aborted'));};
    signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{child.kill('SIGTERM');finish(new Error(`media operation exceeded ${timeoutMs}ms`));},timeoutMs); timer.unref();
  });
}
async function verifyOutput(path:string):Promise<void>{const info=await stat(path);if(!info.isFile()||info.size<1)throw new Error('media processor produced no non-empty output');}
function required(value:string,label:string):string{const result=value?.trim();if(!result)throw new TypeError(`${label} is required`);return result;}
async function capture(command:string,args:string[]):Promise<string>{return new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:['ignore','pipe','pipe'],windowsHide:true});let output='',error='';child.stdout.on('data',chunk=>{output=(output+String(chunk)).slice(-1024*1024);});child.stderr.on('data',chunk=>{error=(error+String(chunk)).slice(-8192);});child.on('error',reject);child.on('exit',code=>code===0?resolve(output):reject(new Error(`ffmpeg inspection failed (${code}): ${error.trim()}`)));});}
function escapeRegExp(value:string):string{return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
