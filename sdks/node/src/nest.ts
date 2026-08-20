import {
  createRhinoQTaskIntegration,
  createBullMQIntegration,
  createPostgresTaskIntegration,
  type BullMQIntegrationPresetOptions,
  type PostgresTaskIntegration,
  type PostgresTaskIntegrationOptions,
  type RhinoQTaskIntegration,
  type RhinoQTaskIntegrationOptions,
} from './integration.js';
import type {
  RhinoQApplicationCompiler,
  RhinoQStartedApplication,
  StartRhinoQApplicationOptions,
} from './runtime/application.js';

export const RHINOQ_OPTIONS = Symbol.for('rhinoq.nest.options');
export const RHINOQ_INTEGRATION = Symbol.for('rhinoq.nest.integration');
export const RHINOQ_TASKS = Symbol.for('rhinoq.nest.tasks');
export const RHINOQ_BRIDGE = Symbol.for('rhinoq.nest.bridge');
export const RHINOQ_HEALTH = Symbol.for('rhinoq.nest.health');
export const RHINOQ_APPLICATION = Symbol.for('rhinoq.nest.application');
export const RHINOQ_MANIFEST = Symbol.for('rhinoq.nest.manifest');
export const RHINOQ_HTTP = Symbol.for('rhinoq.nest.http');

export interface RhinoQModuleFactoryOptions {
  imports?: readonly unknown[];
  inject?: readonly unknown[];
  integrationToken?: unknown;
  useFactory: (...dependencies: any[]) =>
    RhinoQTaskIntegrationOptions | Promise<RhinoQTaskIntegrationOptions>;
}

export interface RhinoQBullMQModuleFactoryOptions {
  imports?: readonly unknown[];
  inject?: readonly unknown[];
  integrationToken?: unknown;
  useFactory: (...dependencies: any[]) =>
    BullMQIntegrationPresetOptions | Promise<BullMQIntegrationPresetOptions>;
}

export interface RhinoQPostgresModuleFactoryOptions {
  imports?: readonly unknown[];
  inject?: readonly unknown[];
  integrationToken?: unknown;
  useFactory: (...dependencies: any[]) =>
    PostgresTaskIntegrationOptions | Promise<PostgresTaskIntegrationOptions>;
}

export interface RhinoQApplicationModuleFactoryOptions {
  imports?: readonly unknown[];
  inject?: readonly unknown[];
  compiler: RhinoQApplicationCompiler<any>;
  useFactory: (...dependencies: any[]) => StartRhinoQApplicationOptions | Promise<StartRhinoQApplicationOptions>;
}

export class RhinoQModule {
  static forRootAsync(options: RhinoQModuleFactoryOptions): any {
    if (!options || typeof options.useFactory !== 'function') {
      throw new TypeError('RhinoQModule.forRootAsync requires useFactory');
    }
    const optionsProvider = {
      provide: RHINOQ_OPTIONS, inject: options.inject ?? [], useFactory: options.useFactory,
    };
    const integrationToken = options.integrationToken ?? RHINOQ_INTEGRATION;
    const integrationProvider = {
      provide: integrationToken,
      inject: [RHINOQ_OPTIONS],
      useFactory: (resolved: RhinoQTaskIntegrationOptions) => createRhinoQTaskIntegration(resolved),
    };
    const lifecycleProvider = {
      provide: RhinoQLifecycle,
      inject: [integrationToken],
      useFactory: (integration: RhinoQTaskIntegration) => new RhinoQLifecycle(integration),
    };
    return {
      module: RhinoQModule,
      imports: options.imports ?? [],
      providers: [optionsProvider, integrationProvider, lifecycleProvider,
        { provide: RHINOQ_TASKS, inject: [integrationToken], useFactory: (i: RhinoQTaskIntegration) => i.tasks },
        { provide: RHINOQ_BRIDGE, inject: [integrationToken], useFactory: (i: RhinoQTaskIntegration) => i.bridge },
        { provide: RHINOQ_HEALTH, inject: [integrationToken], useFactory: (i: RhinoQTaskIntegration) => i.health.bind(i) },
      ],
      exports: [integrationToken, RHINOQ_TASKS, RHINOQ_BRIDGE, RHINOQ_HEALTH],
    };
  }

  static forBullMQAsync(options: RhinoQBullMQModuleFactoryOptions): any {
    return dynamicModule(options, (resolved) => createBullMQIntegration(resolved));
  }

  /**
   * PostgreSQL-only Task integration — no BullMQ, no QueueEvents required.
   *
   * For an application that produces and reads Tasks on PostgreSQL without
   * driving work through BullMQ. It exposes RHINOQ_TASKS and RHINOQ_HEALTH but
   * not RHINOQ_BRIDGE, because there is no queue bridge in this mode.
   *
   * ```ts
   * RhinoQModule.forPostgresAsync({
   *   imports: [ConfigModule], inject: [ConfigService],
   *   useFactory: (config: ConfigService) => ({ pool: config.get('RHINOQ_POOL') }),
   * })
   * ```
   */
  static forPostgresAsync(options: RhinoQPostgresModuleFactoryOptions): any {
    if (!options || typeof options.useFactory !== 'function') {
      throw new TypeError('RhinoQModule.forPostgresAsync requires useFactory');
    }
    const optionsProvider = { provide: RHINOQ_OPTIONS, inject: options.inject ?? [], useFactory: options.useFactory };
    const integrationToken = options.integrationToken ?? RHINOQ_INTEGRATION;
    const integrationProvider = {
      provide: integrationToken,
      inject: [RHINOQ_OPTIONS],
      useFactory: (resolved: PostgresTaskIntegrationOptions) => createPostgresTaskIntegration(resolved),
    };
    const lifecycleProvider = {
      provide: RhinoQLifecycle,
      inject: [integrationToken],
      useFactory: (integration: PostgresTaskIntegration) => new RhinoQLifecycle(integration),
    };
    return {
      module: RhinoQModule,
      imports: options.imports ?? [],
      providers: [optionsProvider, integrationProvider, lifecycleProvider,
        { provide: RHINOQ_TASKS, inject: [integrationToken], useFactory: (i: PostgresTaskIntegration) => i.tasks },
        { provide: RHINOQ_HEALTH, inject: [integrationToken], useFactory: (i: PostgresTaskIntegration) => i.health.bind(i) },
      ],
      exports: [integrationToken, RHINOQ_TASKS, RHINOQ_HEALTH],
    };
  }

  /** Start the typed Application Compiler once and export its Tasks/manifest/HTTP mount. */
  static forApplicationAsync(options: RhinoQApplicationModuleFactoryOptions): any {
    if (!options?.compiler || typeof options.compiler.start !== 'function' || typeof options.useFactory !== 'function') {
      throw new TypeError('RhinoQModule.forApplicationAsync requires compiler and useFactory');
    }
    const optionsProvider = { provide: RHINOQ_OPTIONS, inject: options.inject ?? [], useFactory: options.useFactory };
    const applicationProvider = {
      provide: RHINOQ_APPLICATION,
      inject: [RHINOQ_OPTIONS],
      useFactory: (resolved: StartRhinoQApplicationOptions) => options.compiler.start(resolved),
    };
    const lifecycleProvider = {
      provide: RhinoQApplicationLifecycle,
      inject: [RHINOQ_APPLICATION],
      useFactory: (application: RhinoQStartedApplication<any>) => new RhinoQApplicationLifecycle(application),
    };
    return {
      module: RhinoQModule,
      imports: options.imports ?? [],
      providers: [optionsProvider, applicationProvider, lifecycleProvider,
        { provide: RHINOQ_TASKS, inject: [RHINOQ_APPLICATION], useFactory: (application: RhinoQStartedApplication<any>) => application.tasks },
        { provide: RHINOQ_MANIFEST, inject: [RHINOQ_APPLICATION], useFactory: (application: RhinoQStartedApplication<any>) => application.manifest },
        { provide: RHINOQ_HTTP, inject: [RHINOQ_APPLICATION], useFactory: (application: RhinoQStartedApplication<any>) => application.http },
      ],
      exports: [RHINOQ_APPLICATION, RHINOQ_TASKS, RHINOQ_MANIFEST, RHINOQ_HTTP],
    };
  }
}

function dynamicModule<T>(
  options: { imports?: readonly unknown[]; inject?: readonly unknown[]; integrationToken?: unknown; useFactory: (...dependencies: any[]) => T | Promise<T> },
  create: (resolved: T) => Promise<RhinoQTaskIntegration>,
) {
  if (!options || typeof options.useFactory !== 'function') {
    throw new TypeError('RhinoQModule.forBullMQAsync requires useFactory');
  }
  const optionsProvider = { provide: RHINOQ_OPTIONS, inject: options.inject ?? [], useFactory: options.useFactory };
  const integrationToken = options.integrationToken ?? RHINOQ_INTEGRATION;
  const integrationProvider = { provide: integrationToken, inject: [RHINOQ_OPTIONS], useFactory: create };
  const lifecycleProvider = { provide: RhinoQLifecycle, inject: [integrationToken], useFactory: (integration: RhinoQTaskIntegration) => new RhinoQLifecycle(integration) };
  return {
    module: RhinoQModule,
    imports: options.imports ?? [],
    providers: [optionsProvider, integrationProvider, lifecycleProvider,
      { provide: RHINOQ_TASKS, inject: [integrationToken], useFactory: (i: RhinoQTaskIntegration) => i.tasks },
      { provide: RHINOQ_BRIDGE, inject: [integrationToken], useFactory: (i: RhinoQTaskIntegration) => i.bridge },
      { provide: RHINOQ_HEALTH, inject: [integrationToken], useFactory: (i: RhinoQTaskIntegration) => i.health.bind(i) },
    ],
    exports: [integrationToken, RHINOQ_TASKS, RHINOQ_BRIDGE, RHINOQ_HEALTH],
  };
}

/** Both the BullMQ and PostgreSQL-only integrations expose this start/close pair. */
interface RhinoQStartClose { start(): Promise<void>; close(): void }

export class RhinoQLifecycle {
  constructor(private readonly integration: RhinoQStartClose) {}
  async onModuleInit(): Promise<void> { await this.integration.start(); }
  onModuleDestroy(): void { this.integration.close(); }
}

export class RhinoQApplicationLifecycle {
  constructor(private readonly application: Pick<RhinoQStartedApplication<any>, 'close'>) {}
  onModuleDestroy(): Promise<void> { return this.application.close(); }
}
