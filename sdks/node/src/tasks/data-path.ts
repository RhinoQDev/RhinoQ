export type RhinoQDataPathWorkload = 'task' | 'batch' | 'media' | 'artifact' | 'effect';
export type RhinoQDataPathInputTransport = 'inline' | 'private-reference';
export type RhinoQDataPathOutputTransport = 'private-reference' | 'stream-to-storage';

export interface RhinoQDataPathProviderBounds {
  supportsMultipart?: boolean;
  supportsStreaming?: boolean;
  codecs?: readonly string[];
  minPartBytes?: number;
  maxPartBytes?: number;
  maxParts?: number;
}

export interface RhinoQDataPathOverrides {
  payloadBytes?: number;
  outputBytes?: number;
  memoryBytes?: number;
  workspaceBytes?: number;
  diskFreeBytes?: number;
  minDiskFreeBytes?: number;
  gpu?: string;
  region?: string;
  codec?: string;
  provider?: RhinoQDataPathProviderBounds;
}

export interface RhinoQDataPathPlannerInput extends RhinoQDataPathOverrides {
  workload: RhinoQDataPathWorkload;
}

export interface RhinoQDataPathPlan {
  schemaVersion: 1;
  workload: RhinoQDataPathWorkload;
  input: {
    transport: RhinoQDataPathInputTransport;
    maxInlineBytes: number;
    queueCarries: 'payload' | 'private-reference';
  };
  output: {
    transport: RhinoQDataPathOutputTransport;
    checksumRequired: true;
  };
  multipart?: {
    partBytes: number;
    maxParts: number;
    concurrency: number;
  };
  admission: {
    workspaceBytes?: number;
    diskFreeBytes?: number;
    minDiskFreeBytes?: number;
    gpu?: string;
    region?: string;
    codec?: string;
  };
  decisions: string[];
  needsDecision: string[];
}

export const RHINOQ_INLINE_PAYLOAD_LIMIT_BYTES = 64 * 1024;
const DEFAULT_MEMORY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MIN_PART_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_PART_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_PARTS = 10_000;

/**
 * Compiles metadata into a bounded byte-path plan. It never reads or copies
 * payload bytes and never changes queue or Task state.
 */
export function compileRhinoQDataPathPlan(input: RhinoQDataPathPlannerInput): RhinoQDataPathPlan {
  validateInput(input);
  const inline = (input.payloadBytes === undefined || input.payloadBytes <= RHINOQ_INLINE_PAYLOAD_LIMIT_BYTES) && input.workload !== 'media' && input.workload !== 'artifact';
  const inputTransport: RhinoQDataPathInputTransport = inline ? 'inline' : 'private-reference';
  const outputTransport: RhinoQDataPathOutputTransport = input.workload === 'media' || input.workload === 'artifact'
    ? 'stream-to-storage'
    : 'private-reference';
  const decisions = [
    inputTransport === 'inline' ? `inline payload is bounded at ${RHINOQ_INLINE_PAYLOAD_LIMIT_BYTES} bytes` : 'queue carries only a private object reference for this workload',
    outputTransport === 'stream-to-storage' ? 'large output streams to storage with checksum and backpressure' : 'result remains a private reference outside the queue payload',
  ];
  const needsDecision: string[] = [];
  if (input.payloadBytes !== undefined && input.payloadBytes > RHINOQ_INLINE_PAYLOAD_LIMIT_BYTES && !input.provider?.supportsMultipart && (input.workload === 'media' || input.workload === 'artifact')) {
    needsDecision.push('provider must support direct multipart transfer for the declared large input');
  }
  if (input.payloadBytes === undefined && input.workload !== 'media' && input.workload !== 'artifact') {
    needsDecision.push(`payload size is unknown; dispatch must enforce the ${RHINOQ_INLINE_PAYLOAD_LIMIT_BYTES}-byte inline limit`);
  }
  const minimumDisk = input.minDiskFreeBytes ?? input.workspaceBytes;
  if (minimumDisk !== undefined && input.diskFreeBytes === undefined) {
    needsDecision.push('available disk was not observed; runtime admission must verify the declared minimum before execution');
  }
  if (minimumDisk !== undefined && input.diskFreeBytes !== undefined && input.diskFreeBytes < minimumDisk) {
    needsDecision.push('available disk is below the declared workspace requirement; admission must fail closed');
  }
  if (input.gpu) needsDecision.push('GPU capacity was declared but not proven by a runtime admission snapshot');
  if (input.region) needsDecision.push('region capacity was declared but not proven by a runtime admission snapshot');
  if (input.codec && !input.provider?.codecs?.includes(input.codec)) {
    needsDecision.push('declared codec is not proven available by the selected provider capability set');
  }
  if (input.gpu || input.region) {
    decisions.push('GPU and region requirements are metadata admission gates; the runtime must verify capacity before execution');
  }
  const plan: RhinoQDataPathPlan = {
    schemaVersion: 1,
    workload: input.workload,
    input: {
      transport: inputTransport,
      maxInlineBytes: RHINOQ_INLINE_PAYLOAD_LIMIT_BYTES,
      queueCarries: inputTransport === 'inline' ? 'payload' : 'private-reference',
    },
    output: { transport: outputTransport, checksumRequired: true },
    admission: {
      ...(input.workspaceBytes === undefined ? {} : { workspaceBytes: input.workspaceBytes }),
      ...(input.diskFreeBytes === undefined ? {} : { diskFreeBytes: input.diskFreeBytes }),
      ...(input.minDiskFreeBytes === undefined ? {} : { minDiskFreeBytes: input.minDiskFreeBytes }),
      ...(input.gpu ? { gpu: input.gpu } : {}),
      ...(input.region ? { region: input.region } : {}),
      ...(input.codec ? { codec: input.codec } : {}),
    },
    decisions,
    needsDecision,
  };
  if (input.payloadBytes !== undefined && input.payloadBytes > RHINOQ_INLINE_PAYLOAD_LIMIT_BYTES && input.provider?.supportsMultipart) {
    plan.multipart = multipartPlan(input);
  }
  return Object.freeze(plan);
}

function multipartPlan(input: RhinoQDataPathPlannerInput): NonNullable<RhinoQDataPathPlan['multipart']> {
  const provider = input.provider ?? {};
  const minPart = provider.minPartBytes ?? DEFAULT_MIN_PART_BYTES;
  const maxPart = provider.maxPartBytes ?? DEFAULT_MAX_PART_BYTES;
  const maxParts = provider.maxParts ?? DEFAULT_MAX_PARTS;
  const memory = input.memoryBytes ?? DEFAULT_MEMORY_BYTES;
  const partBytes = Math.max(minPart, Math.min(maxPart, Math.floor(memory / 4), Math.ceil(input.payloadBytes! / maxParts)));
  const parts = Math.ceil(input.payloadBytes! / partBytes);
  const needsInvalidBounds = parts > maxParts || partBytes > maxPart;
  if (needsInvalidBounds) throw new RangeError('data path payload exceeds provider multipart bounds');
  return { partBytes, maxParts, concurrency: Math.max(1, Math.min(8, Math.floor(memory / partBytes))) };
}

function validateInput(input: RhinoQDataPathPlannerInput): void {
  if (!input || !['task', 'batch', 'media', 'artifact', 'effect'].includes(input.workload)) throw new TypeError('data path workload is required');
  for (const [name, value] of [['payloadBytes', input.payloadBytes], ['outputBytes', input.outputBytes], ['memoryBytes', input.memoryBytes], ['workspaceBytes', input.workspaceBytes], ['diskFreeBytes', input.diskFreeBytes], ['minDiskFreeBytes', input.minDiskFreeBytes]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new RangeError(`data path ${name} must be a non-negative safe integer`);
  }
  if (input.memoryBytes !== undefined && input.memoryBytes < 4) throw new RangeError('data path memoryBytes must be at least 4');
  if (input.provider) {
    for (const [name, value] of [['minPartBytes', input.provider.minPartBytes], ['maxPartBytes', input.provider.maxPartBytes], ['maxParts', input.provider.maxParts]] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new RangeError(`data path provider ${name} must be a positive safe integer`);
    }
    if (input.provider.minPartBytes !== undefined && input.provider.maxPartBytes !== undefined && input.provider.minPartBytes > input.provider.maxPartBytes) {
      throw new RangeError('data path provider minPartBytes must not exceed maxPartBytes');
    }
    if (input.provider.codecs !== undefined && (!Array.isArray(input.provider.codecs) || input.provider.codecs.some((codec) => typeof codec !== 'string' || !codec.trim()))) {
      throw new TypeError('data path provider codecs must be non-empty strings');
    }
  }
  for (const [name, value] of [['gpu', input.gpu], ['region', input.region], ['codec', input.codec]] as const) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) throw new TypeError(`data path ${name} must be a non-empty string`);
  }
}
