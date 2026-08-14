import type { TaskArtifact } from '../gateway/types.js';
import {
  inspectRhinoQMediaRuntime,
  type RhinoQMediaProbe,
  type RhinoQMediaRuntimeReport,
  type RhinoQThumbnailOptions,
  type RhinoQTranscodeOptions,
} from './media.js';
import type { RhinoQTaskRunContext } from './declaration.js';
import { createRhinoQModule, type RhinoQLifecycleModule } from '../runtime/modules.js';

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

/**
 * Minimal image-provider boundary for adopters that already run Sharp. The
 * SDK does not bundle the native package, credentials or a second worker
 * process; the application injects those choices and owns their lifecycle.
 */
export interface RhinoQSharpRuntime {
  version?: string;
  available(): Promise<boolean> | boolean;
  metadata(inputPath: string): Promise<Record<string, unknown>> | Record<string, unknown>;
  resize(inputPath: string, outputPath: string, options?: RhinoQSharpResizeOptions): Promise<void> | void;
}

export interface RhinoQSharpResizeOptions {
  width?: number;
  height?: number;
  format?: string;
}

export interface RhinoQSharpProcessorInput {
  operation: 'metadata' | 'resize';
  inputPath: string;
  outputPath?: string;
  resize?: RhinoQSharpResizeOptions;
}

export type RhinoQSharpProcessorOutput = TaskArtifact | Record<string, unknown>;

/** Provider-demand adapter: package installation and image policy stay application-owned. */
export function createRhinoQSharpProcessorPack(
  runtime: RhinoQSharpRuntime,
  options: { requiresWorkspace?: boolean } = {},
): RhinoQProcessorPack<RhinoQSharpProcessorInput, RhinoQSharpProcessorOutput> {
  if (!runtime || typeof runtime.available !== 'function' || typeof runtime.metadata !== 'function' || typeof runtime.resize !== 'function') {
    throw new TypeError('Sharp processor pack requires an injected runtime with available, metadata and resize');
  }
  const inspect = async (): Promise<RhinoQProcessorPackReadiness> => {
    const ready = await runtime.available();
    return {
      schemaVersion: 1,
      name: 'sharp',
      version: 1,
      ready: ready === true,
      checkedAt: new Date().toISOString(),
      requirements: ['application-provided Sharp-compatible runtime'],
      missing: ready === true ? [] : ['Sharp-compatible runtime'],
      warnings: runtime.version ? [] : ['provider version was not supplied'],
    };
  };
  return createRhinoQProcessorPack({
    name: 'sharp',
    version: 1,
    requiresWorkspace: options.requiresWorkspace ?? true,
    inspect,
    process: async (input, context) => {
      if (!input || !['metadata', 'resize'].includes(input.operation)) throw new TypeError('Sharp processor operation must be metadata or resize');
      const inputPath = required(input.inputPath, 'processor inputPath');
      if (input.operation === 'metadata') return runtime.metadata(inputPath);
      const outputPath = required(input.outputPath, 'processor outputPath');
      const resize = input.resize ?? {};
      for (const value of [resize.width, resize.height]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new RangeError('Sharp resize dimensions must be positive integers');
      if (resize.format !== undefined && (!resize.format.trim() || resize.format.length > 32)) throw new TypeError('Sharp resize format must be a short non-empty string');
      await runtime.resize(inputPath, outputPath, resize);
      return context.output.file(outputPath, { contentType: resize.format ? `image/${resize.format.toLowerCase()}` : undefined });
    },
  });
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
  /** Provider lifecycle boundary; Task correctness remains outside the pack. */
  readonly module: RhinoQLifecycleModule;
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
  let readinessForValidation: RhinoQProcessorPackReadiness | undefined;
  const module = createRhinoQModule({
    descriptor: { id: `processor/${name}`, namespace: 'processor', version, contractVersion: 1 },
    validate: () => {
      if (!readinessForValidation || readinessForValidation.schemaVersion !== 1
        || readinessForValidation.name !== name || readinessForValidation.version !== version) {
        throw new TypeError(`processor pack ${name} returned an invalid readiness report`);
      }
    },
  });
  return Object.freeze({
    name,
    version,
    requiresWorkspace,
    module,
    async inspect() {
      await module.provision();
      const report = await options.inspect();
      readinessForValidation = report;
      await module.validate();
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
