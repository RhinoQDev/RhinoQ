import type { TaskArtifact } from '../gateway/types.js';
import {
  inspectRhinoQMediaRuntime,
  type RhinoQMediaProbe,
  type RhinoQMediaRuntimeReport,
  type RhinoQThumbnailOptions,
  type RhinoQTranscodeOptions,
} from './media.js';
import type { RhinoQTaskRunContext } from './declaration.js';

export type RhinoQProcessorErrorClass =
  | 'cancelled'
  | 'timeout'
  | 'capacity'
  | 'dependency'
  | 'input'
  | 'output'
  | 'unknown';

export type RhinoQProcessorPackCatalogStatus = 'available' | 'provider-package-required';

export interface RhinoQProcessorPackCatalogEntry {
  name: 'sharp' | 'ffmpeg' | 'libreoffice' | 'malware-scanner' | 'ai-model';
  status: RhinoQProcessorPackCatalogStatus;
  boundary: 'application-owned adapter';
  evidence: string;
}

/** Honest catalog: discoverability is separate from claiming a provider implementation. */
export const RHINOQ_PROCESSOR_PACK_CATALOG: readonly RhinoQProcessorPackCatalogEntry[] = Object.freeze([
  { name: 'sharp', status: 'provider-package-required', boundary: 'application-owned adapter', evidence: 'No image provider is bundled; supply readiness, cleanup and error classification.' },
  { name: 'ffmpeg', status: 'available', boundary: 'application-owned adapter', evidence: 'Built-in bounded adapter uses the media runtime probe and Task workspace.' },
  { name: 'libreoffice', status: 'provider-package-required', boundary: 'application-owned adapter', evidence: 'No office conversion binary or output policy is bundled.' },
  { name: 'malware-scanner', status: 'provider-package-required', boundary: 'application-owned adapter', evidence: 'Scanner verdict and quarantine policy remain application-owned.' },
  { name: 'ai-model', status: 'provider-package-required', boundary: 'application-owned adapter', evidence: 'Model/provider credentials, cost and semantic confirmation remain application-owned.' },
]);

export function listRhinoQProcessorPackCatalog(): readonly RhinoQProcessorPackCatalogEntry[] {
  return RHINOQ_PROCESSOR_PACK_CATALOG;
}

export interface RhinoQProcessorPackReadiness {
  schemaVersion: 1;
  name: string;
  version: number;
  ready: boolean;
  checkedAt: string;
  requirements: readonly string[];
  missing: readonly string[];
  warnings: readonly string[];
}

export type RhinoQProcessorPackContext = Pick<
  RhinoQTaskRunContext,
  'signal' | 'progress' | 'artifact' | 'output' | 'media' | 'workspace'
> & {
  /** Optional application metric sink; the pack never owns a metrics backend. */
  metric?(name: string, by?: number): void;
};

export interface RhinoQProcessorPack<Input, Output> {
  readonly name: string;
  readonly version: number;
  readonly requiresWorkspace: boolean;
  inspect(): Promise<RhinoQProcessorPackReadiness>;
  run(input: Input, context: RhinoQProcessorPackContext): Promise<Output>;
  classify(error: unknown): RhinoQProcessorErrorClass;
}

export class RhinoQProcessorPackError extends Error {
  readonly code = 'RHINOQ_PROCESSOR_PACK';
  constructor(
    readonly errorClass: RhinoQProcessorErrorClass,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RhinoQProcessorPackError';
  }
}

export interface CreateRhinoQProcessorPackOptions<Input, Output> {
  name: string;
  version?: number;
  requiresWorkspace?: boolean;
  inspect(): Promise<RhinoQProcessorPackReadiness> | RhinoQProcessorPackReadiness;
  process(input: Input, context: RhinoQProcessorPackContext): Promise<Output> | Output;
  cleanup?(input: Input, context: RhinoQProcessorPackContext): Promise<void> | void;
  classify?(error: unknown): RhinoQProcessorErrorClass;
}

/**
 * Wraps repeatable specialist lifecycle without owning Task correctness.
 * Readiness is checked before work, cancellation is inherited from the Task,
 * and cleanup cannot hide a primary processor failure.
 */
export function createRhinoQProcessorPack<Input, Output>(
  options: CreateRhinoQProcessorPackOptions<Input, Output>,
): RhinoQProcessorPack<Input, Output> {
  const name = required(options?.name, 'processor pack name');
  const version = options.version ?? 1;
  if (!Number.isSafeInteger(version) || version < 1) throw new RangeError('processor pack version must be a positive integer');
  if (typeof options.inspect !== 'function') throw new TypeError('processor pack inspect is required');
  if (typeof options.process !== 'function') throw new TypeError('processor pack process is required');
  const requiresWorkspace = options.requiresWorkspace === true;
  const classify = options.classify ?? classifyRhinoQProcessorError;
  return Object.freeze({
    name,
    version,
    requiresWorkspace,
    async inspect() {
      const report = await options.inspect();
      if (!report || report.schemaVersion !== 1 || report.name !== name || report.version !== version) {
        throw new TypeError(`processor pack ${name} returned an invalid readiness report`);
      }
      return report;
    },
    async run(input: Input, context: RhinoQProcessorPackContext): Promise<Output> {
      if (context?.signal?.aborted) throw new RhinoQProcessorPackError('cancelled', `processor pack ${name} was cancelled`, context.signal.reason);
      if (requiresWorkspace && !context?.workspace) {
        throw new RhinoQProcessorPackError('capacity', `processor pack ${name} requires a Task workspace`);
      }
      const readiness = await this.inspect();
      if (!readiness.ready) {
        throw new RhinoQProcessorPackError(
          'dependency',
          `processor pack ${name} is not ready${readiness.missing.length ? `: ${readiness.missing.join(', ')}` : ''}`,
        );
      }
      context.metric?.('rhinoq_processor_pack_started_total');
      let failure: unknown;
      try {
        const result = await options.process(input, context);
        context.metric?.('rhinoq_processor_pack_completed_total');
        return result;
      } catch (error) {
        failure = error;
        context.metric?.('rhinoq_processor_pack_failed_total');
        if (error instanceof RhinoQProcessorPackError) throw error;
        throw new RhinoQProcessorPackError(classify(error), `processor pack ${name} failed`, error);
      } finally {
        try {
          await options.cleanup?.(input, context);
        } catch (error) {
          context.metric?.('rhinoq_processor_pack_cleanup_failed_total');
          if (failure === undefined) throw new RhinoQProcessorPackError('output', `processor pack ${name} cleanup failed`, error);
        }
      }
    },
    classify,
  });
}

export interface RhinoQFFmpegProcessorInput {
  operation: 'probe' | 'transcode' | 'thumbnail';
  inputPath: string;
  outputPath?: string;
  transcode?: RhinoQTranscodeOptions;
  thumbnail?: RhinoQThumbnailOptions;
  probe?: { timeoutMs?: number };
}

export type RhinoQFFmpegProcessorOutput = TaskArtifact | RhinoQMediaProbe;

export interface RhinoQFFmpegProcessorOptions {
  ffmpegPath?: string;
  requiredEncoders?: string[];
  workDirectory?: string;
  minimumFreeBytes?: number;
  requiresWorkspace?: boolean;
}

/** FFmpeg pack built on the existing bounded media context and readiness probe. */
export function createRhinoQFFmpegProcessorPack(
  options: RhinoQFFmpegProcessorOptions = {},
): RhinoQProcessorPack<RhinoQFFmpegProcessorInput, RhinoQFFmpegProcessorOutput> {
  const readiness = async (): Promise<RhinoQProcessorPackReadiness> => {
    const report: RhinoQMediaRuntimeReport = await inspectRhinoQMediaRuntime(options);
    return {
      schemaVersion: 1,
      name: 'ffmpeg',
      version: 1,
      ready: report.ready,
      checkedAt: new Date().toISOString(),
      requirements: [
        `ffmpeg binary ${report.ffmpegPath}`,
        ...report.requiredEncoders.map((encoder) => `encoder ${encoder}`),
        `free workspace >= ${report.minimumFreeBytes} bytes`,
      ],
      missing: [
        ...report.missingEncoders.map((encoder) => `encoder ${encoder}`),
        ...(report.freeBytes < report.minimumFreeBytes ? [`free workspace ${report.freeBytes} bytes`] : []),
      ],
      warnings: report.version ? [] : ['ffmpeg version could not be identified'],
    };
  };
  return createRhinoQProcessorPack({
    name: 'ffmpeg',
    version: 1,
    requiresWorkspace: options.requiresWorkspace ?? true,
    inspect: readiness,
    process: async (input, context) => {
      if (!input || !['probe', 'transcode', 'thumbnail'].includes(input.operation)) {
        throw new TypeError('processor operation must be probe, transcode or thumbnail');
      }
      const inputPath = required(input?.inputPath, 'processor inputPath');
      if (input.operation === 'probe') return context.media.probe(inputPath, input.probe);
      const outputPath = required(input.outputPath, 'processor outputPath');
      if (input.operation === 'transcode') return context.media.transcode(inputPath, outputPath, input.transcode);
      return context.media.thumbnail(inputPath, outputPath, input.thumbnail);
    },
  });
}

function classifyRhinoQProcessorError(error: unknown): RhinoQProcessorErrorClass {
  if (error instanceof RhinoQProcessorPackError) return error.errorClass;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes('abort') || message.includes('cancel')) return 'cancelled';
  if (message.includes('timeout') || message.includes('exceeded')) return 'timeout';
  if (message.includes('capacity') || message.includes('free bytes') || message.includes('workspace')) return 'capacity';
  if (message.includes('not found') || message.includes('encoder') || message.includes('ffmpeg')) return 'dependency';
  if (message.includes('input') || message.includes('path')) return 'input';
  if (message.includes('output') || message.includes('artifact')) return 'output';
  return 'unknown';
}

function required(value: string | undefined, label: string): string {
  const result = value?.trim();
  if (!result) throw new TypeError(`${label} is required`);
  return result;
}
