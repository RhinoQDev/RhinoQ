import type { TaskSnapshot } from '../gateway/types.js';
import type { RhinoQDeclaredTask, RhinoQTaskDispatch, RhinoQTaskOptions, RhinoQTaskRetryPolicy } from '../tasks/declaration.js';
import type { RuntimeAdapter } from './contracts.js';
import {
  createRhinoQApp,
  type CreateRhinoQAppOptions,
  type RhinoQAppHTTPMiddleware,
  type RhinoQAppHTTPOptions,
  type RhinoQPortableApp,
} from './app.js';

export interface RhinoQExecutionProfile {
  /** Stable application-facing profile name, for example `reports`. */
  name: string;
  /** Adapter instances are still the authority for dispatch and observation. */
  adapters: RuntimeAdapter[];
  /** Adapter selected by Tasks that do not override the profile. */
  adapter?: string;
  runtime?: string;
  scope?: string;
}

export type RhinoQApplicationTaskOptions<Input, Output> = Omit<
  RhinoQTaskOptions<Input, Output>,
  'adapter' | 'runtime' | 'scope'
> & Partial<Pick<RhinoQTaskOptions<Input, Output>, 'adapter' | 'runtime' | 'scope'>>;

export interface RhinoQTaskBlueprint<Input, Output> {
  readonly options: RhinoQApplicationTaskOptions<Input, Output>;
}

export interface RhinoQApplicationTaskFactory {
  <Input, Output>(options: RhinoQApplicationTaskOptions<Input, Output>): RhinoQTaskBlueprint<Input, Output>;
  batch<Input, Output>(options: Omit<RhinoQApplicationTaskOptions<Input, Output>, 'batch'> & { maxItems?: number }): RhinoQTaskBlueprint<Input, Output>;
  external<Input, Output>(options: Omit<RhinoQApplicationTaskOptions<Input, Output>, 'externalEffect'> & { effect: NonNullable<RhinoQTaskOptions<Input, Output>['effect']> }): RhinoQTaskBlueprint<Input, Output>;
}

// `any` is intentional at the heterogeneous registry boundary; the mapped
// type below immediately recovers each Task's exact input/output pair.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBlueprint = RhinoQTaskBlueprint<any, any>;
type BlueprintRecord = Record<string, AnyBlueprint>;
type BoundTask<Blueprint> = Blueprint extends RhinoQTaskBlueprint<infer Input, infer Output>
  ? RhinoQDeclaredTask<Input, Output>
  : never;
export type RhinoQApplicationTasks<Definitions extends BlueprintRecord> = {
  readonly [Key in keyof Definitions]: BoundTask<Definitions[Key]>;
};

export interface RhinoQTaskManifestEntry {
  key: string;
  name: string;
  version: number;
  adapter: string;
  runtime: string;
  scope: string;
  retry: RhinoQTaskRetryPolicy;
  externalEffect: boolean;
  batch?: { maxItems: number };
  execution?: { delayMs?: number; priority?: number };
}

export interface RhinoQApplicationManifest {
  readonly schemaVersion: 1;
  readonly profile: string;
  readonly tasks: readonly Readonly<RhinoQTaskManifestEntry>[];
}

export interface DefineRhinoQApplicationOptions<Definitions extends BlueprintRecord> {
  profile: RhinoQExecutionProfile;
  tasks(task: RhinoQApplicationTaskFactory): Definitions;
}

export interface StartRhinoQApplicationOptions extends Omit<CreateRhinoQAppOptions, 'adapters'> {
  http?: RhinoQAppHTTPOptions;
}

export interface RhinoQStartedApplication<Definitions extends BlueprintRecord> {
  readonly app: RhinoQPortableApp;
  readonly tasks: RhinoQApplicationTasks<Definitions>;
  readonly manifest: RhinoQApplicationManifest;
  /** The complete owner API, Task Center and Workbench middleware. */
  readonly http?: RhinoQAppHTTPMiddleware;
  /** Handler map for runtimes that register one processor per Task name. */
  workerHandlers(): Readonly<Record<string, RhinoQApplicationWorkerHandler>>;
  /** One fail-closed router for runtimes that deliver multiple Task names. */
  workerHandler(): RhinoQApplicationWorkerHandler;
  /** Run one runtime worker until abort/SIGINT/SIGTERM, then close it within the deadline. */
  runWorker(options: RhinoQApplicationRunWorkerOptions): Promise<void>;
  mount(options: RhinoQAppHTTPOptions): RhinoQAppHTTPMiddleware;
  close(): Promise<void>;
}

export interface RhinoQApplicationWorkerRuntime {
  close(): Promise<unknown> | unknown;
}

export interface RhinoQApplicationRunWorkerOptions {
  create(handler: RhinoQApplicationWorkerHandler): Promise<RhinoQApplicationWorkerRuntime> | RhinoQApplicationWorkerRuntime;
  signal?: AbortSignal;
  shutdownTimeoutMs?: number;
  processSignals?: boolean;
}

export interface RhinoQApplicationWorkerJob {
  data: unknown;
  updateProgress?(progress: { completed: number; total?: number; message?: string }): Promise<unknown> | unknown;
  signal?: AbortSignal;
}

export type RhinoQApplicationWorkerHandler = (job: RhinoQApplicationWorkerJob) => Promise<unknown>;

export interface RhinoQApplicationCompiler<Definitions extends BlueprintRecord> {
  readonly definitions: Definitions;
  manifest(): RhinoQApplicationManifest;
  start(options: StartRhinoQApplicationOptions): Promise<RhinoQStartedApplication<Definitions>>;
}

/**
 * Compile one typed Task registry into dispatchers, worker handlers, a static
 * manifest and one mountable HTTP surface. This is composition only: the Go
 * engine and runtime adapters remain authoritative for execution correctness.
 */
export function defineRhinoQApplication<Definitions extends BlueprintRecord>(
  options: DefineRhinoQApplicationOptions<Definitions>,
): RhinoQApplicationCompiler<Definitions> {
  const profile = validateProfile(options?.profile);
  if (typeof options?.tasks !== 'function') throw new TypeError('application tasks factory is required');
  const definitions = Object.freeze(options.tasks(createTaskFactory()));
  const entries = compileEntries(definitions, profile);
  const manifest = Object.freeze({
    schemaVersion: 1 as const,
    profile: profile.name,
    tasks: Object.freeze(entries.map(({ options: _options, ...entry }) => Object.freeze(entry))),
  });

  return Object.freeze({
    definitions,
    manifest: () => manifest,
    async start(startOptions: StartRhinoQApplicationOptions) {
      const { http: httpOptions, ...appOptions } = startOptions;
      const app = await createRhinoQApp({ ...appOptions, adapters: profile.adapters });
      try {
        const tasks = {} as RhinoQApplicationTasks<Definitions>;
        for (const entry of entries) {
          Object.defineProperty(tasks, entry.key, {
            enumerable: true,
            value: app.task(entry.options as RhinoQTaskOptions<unknown, unknown>),
          });
        }
        Object.freeze(tasks);
        const handlers: Record<string, RhinoQApplicationWorkerHandler> = {};
        for (const entry of entries) handlers[entry.name] = tasks[entry.key]!.workerHandler();
        Object.freeze(handlers);
        const routeWorker: RhinoQApplicationWorkerHandler = async (job) => {
          const taskName = workerTaskName(job?.data);
          const handler = handlers[taskName];
          if (!handler) throw new TypeError(`RhinoQ worker refuses unregistered Task ${JSON.stringify(taskName)}`);
          return handler(job);
        };
        const started: RhinoQStartedApplication<Definitions> = {
          app,
          tasks,
          manifest,
          ...(httpOptions ? { http: app.http(httpOptions) } : {}),
          workerHandlers: () => handlers,
          workerHandler: () => routeWorker,
          runWorker: (options) => runApplicationWorker(routeWorker, options),
          mount: (mountOptions) => app.http(mountOptions),
          close: () => app.close(),
        };
        return Object.freeze(started);
      } catch (error) {
        await app.close();
        throw error;
      }
    },
  });
}

async function runApplicationWorker(handler: RhinoQApplicationWorkerHandler, options: RhinoQApplicationRunWorkerOptions): Promise<void> {
  if (typeof options?.create !== 'function') throw new TypeError('runWorker requires a worker create function');
  const timeoutMs = options.shutdownTimeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('worker shutdownTimeoutMs must be a positive integer');
  if (options.signal?.aborted) return;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const useProcessSignals = options.processSignals !== false;
  if (useProcessSignals) {
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
  }
  let worker: RhinoQApplicationWorkerRuntime | undefined;
  try {
    worker = await options.create(handler);
    if (!worker || typeof worker.close !== 'function') throw new TypeError('worker create must return an object with close()');
    if (!controller.signal.aborted) await new Promise<void>((resolve) => controller.signal.addEventListener('abort', () => resolve(), { once: true }));
    await closeWorkerWithin(worker, timeoutMs);
  } finally {
    options.signal?.removeEventListener('abort', abort);
    if (useProcessSignals) {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    }
  }
}

async function closeWorkerWithin(worker: RhinoQApplicationWorkerRuntime, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(worker.close()).then(() => undefined),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`worker did not close within ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function workerTaskName(value: unknown): string {
  if (!value || typeof value !== 'object') throw new TypeError('RhinoQ worker received an invalid Task envelope');
  const taskName = (value as { taskName?: unknown }).taskName;
  if (typeof taskName !== 'string' || !taskName.trim()) throw new TypeError('RhinoQ worker Task envelope requires taskName');
  return taskName;
}

/** A named profile removes adapter/runtime/scope repetition without hiding it. */
export function defineRhinoQExecutionProfile(profile: RhinoQExecutionProfile): RhinoQExecutionProfile {
  return Object.freeze(validateProfile(profile));
}

function taskBlueprint<Input, Output>(
  options: RhinoQApplicationTaskOptions<Input, Output>,
): RhinoQTaskBlueprint<Input, Output> {
  if (!options || typeof options !== 'object') throw new TypeError('Task options are required');
  return Object.freeze({ options });
}

function createTaskFactory(): RhinoQApplicationTaskFactory {
  const factory = ((options: RhinoQApplicationTaskOptions<unknown, unknown>) => taskBlueprint(options)) as RhinoQApplicationTaskFactory;
  factory.batch = (options) => {
    const { maxItems, ...taskOptions } = options;
    return taskBlueprint({ ...taskOptions, batch: { ...(maxItems === undefined ? {} : { maxItems }) } });
  };
  factory.external = (options) => taskBlueprint({ ...options, externalEffect: true });
  return Object.freeze(factory);
}

function validateProfile(profile: RhinoQExecutionProfile): RhinoQExecutionProfile {
  const name = required(profile?.name, 'execution profile name');
  if (!Array.isArray(profile?.adapters) || profile.adapters.length === 0) {
    throw new TypeError('execution profile requires at least one adapter');
  }
  const adapter = required(profile.adapter ?? profile.adapters[0]?.name, 'execution profile adapter');
  const selected = profile.adapters.find((candidate) => candidate.name === adapter);
  if (!selected) throw new TypeError(`execution profile adapter ${JSON.stringify(adapter)} is not registered`);
  return {
    name,
    adapters: [...profile.adapters],
    adapter,
    runtime: required(profile.runtime ?? selected.name, 'execution profile runtime'),
    scope: required(profile.scope ?? selected.scope, 'execution profile scope'),
  };
}

function compileEntries<Definitions extends BlueprintRecord>(definitions: Definitions, profile: RhinoQExecutionProfile) {
  const names = new Set<string>();
  return Object.entries(definitions).map(([key, blueprint]) => {
    if (!blueprint?.options) throw new TypeError(`Task ${JSON.stringify(key)} is not a RhinoQ Task blueprint`);
    const taskOptions = blueprint.options;
    const name = required(taskOptions.name, `Task ${key} name`);
    if (names.has(name)) throw new TypeError(`duplicate Task name ${JSON.stringify(name)}`);
    names.add(name);
    const version = taskOptions.version ?? 1;
    if (!Number.isInteger(version) || version < 1) throw new RangeError(`Task ${JSON.stringify(key)} version must be a positive integer`);
    const adapter = required(taskOptions.adapter ?? profile.adapter, `Task ${key} adapter`);
    if (!profile.adapters.some((candidate) => candidate.name === adapter)) {
      throw new TypeError(`Task ${JSON.stringify(key)} selects unregistered adapter ${JSON.stringify(adapter)}`);
    }
    const runtime = required(taskOptions.runtime ?? profile.runtime, `Task ${key} runtime`);
    const scope = required(taskOptions.scope ?? profile.scope, `Task ${key} scope`);
    if (typeof taskOptions.run !== 'function') throw new TypeError(`Task ${JSON.stringify(key)} run handler is required`);
    if (taskOptions.externalEffect && !taskOptions.effect) {
      throw new TypeError(`external-effect Task ${JSON.stringify(key)} requires explicit idempotency and confirmation policy`);
    }
    if (taskOptions.retry?.mode === 'runtime' && (!Number.isInteger(taskOptions.retry.maxAttempts) || taskOptions.retry.maxAttempts < 1)) {
      throw new RangeError(`Task ${JSON.stringify(key)} retry maxAttempts must be a positive integer`);
    }
    if (taskOptions.retry?.mode === 'runtime' && taskOptions.retry.backoff
      && (!Number.isFinite(taskOptions.retry.backoff.delayMs) || taskOptions.retry.backoff.delayMs < 1)) {
      throw new RangeError(`Task ${JSON.stringify(key)} retry backoff delayMs must be a positive number`);
    }
    const retry = freezeRetry(taskOptions.retry);
    const effect = taskOptions.effect ? Object.freeze({ ...taskOptions.effect }) : undefined;
    const batch = taskOptions.batch ? Object.freeze({ maxItems: taskOptions.batch.maxItems ?? 1_000 }) : undefined;
    if (batch && (!Number.isInteger(batch.maxItems) || batch.maxItems < 1 || batch.maxItems > 10_000)) {
      throw new RangeError(`Task ${JSON.stringify(key)} batch maxItems must be 1..10000`);
    }
    const execution = taskOptions.execution ? Object.freeze({ ...taskOptions.execution }) : undefined;
    if (execution?.delayMs !== undefined && (!Number.isInteger(execution.delayMs) || execution.delayMs < 0)) {
      throw new RangeError(`Task ${JSON.stringify(key)} execution delayMs must be a non-negative integer`);
    }
    if (execution?.priority !== undefined && !Number.isInteger(execution.priority)) {
      throw new RangeError(`Task ${JSON.stringify(key)} execution priority must be an integer`);
    }
    const options = Object.freeze({
      ...taskOptions, name, adapter, runtime, scope, retry,
      ...(effect ? { effect } : {}),
      ...(batch ? { batch } : {}),
      ...(execution ? { execution } : {}),
    }) as RhinoQTaskOptions<unknown, unknown>;
    return {
      key, name, version, adapter, runtime, scope,
      retry,
      externalEffect: taskOptions.externalEffect ?? false,
      ...(batch ? { batch } : {}),
      ...(execution ? { execution } : {}),
      options,
    };
  });
}

function freezeRetry(retry: RhinoQTaskRetryPolicy | undefined): RhinoQTaskRetryPolicy {
  if (!retry || retry.mode === 'never') return Object.freeze({ mode: 'never' });
  return Object.freeze({
    mode: 'runtime',
    maxAttempts: retry.maxAttempts,
    ...(retry.backoff ? { backoff: Object.freeze({ ...retry.backoff }) } : {}),
  });
}

function required(value: string | undefined, label: string): string {
  const result = value?.trim();
  if (!result) throw new TypeError(`${label} is required`);
  return result;
}

/** Useful for framework adapters that accept only a typed dispatch function. */
export type RhinoQTaskDispatcher<Input> = (request: RhinoQTaskDispatch<Input>) => Promise<TaskSnapshot>;
