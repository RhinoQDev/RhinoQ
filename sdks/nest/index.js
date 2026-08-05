/**
 * NestJS dynamic-module metadata without a runtime dependency on Nest.
 *
 * Nest consumes the returned DynamicModule structurally. Keeping this small
 * adapter free of decorators means applications can use their existing Nest
 * version, while @rhinoq/node remains the only implementation dependency.
 */
export const RHINOQ_OPTIONS = Symbol.for('rhinoq.nest.options');
export const RHINOQ_INTEGRATION = Symbol.for('rhinoq.nest.integration');
export const RHINOQ_TASKS = Symbol.for('rhinoq.nest.tasks');
export const RHINOQ_BRIDGE = Symbol.for('rhinoq.nest.bridge');
export const RHINOQ_HEALTH = Symbol.for('rhinoq.nest.health');

export class RhinoQModule {
  static forRootAsync(options) {
    if (!options || typeof options.useFactory !== 'function') {
      throw new TypeError('RhinoQModule.forRootAsync requires useFactory');
    }
    const optionsProvider = {
      provide: RHINOQ_OPTIONS,
      inject: options.inject ?? [],
      useFactory: options.useFactory,
    };
    const integrationProvider = {
      provide: RHINOQ_INTEGRATION,
      inject: [RHINOQ_OPTIONS],
      useFactory: (resolved) => createIntegration(resolved),
    };
    const lifecycleProvider = {
      provide: RhinoQLifecycle,
      inject: [RHINOQ_INTEGRATION],
      useFactory: (integration) => new RhinoQLifecycle(integration),
    };
    return {
      module: RhinoQModule,
      imports: options.imports ?? [],
      providers: [optionsProvider, integrationProvider, lifecycleProvider,
        { provide: RHINOQ_TASKS, inject: [RHINOQ_INTEGRATION], useFactory: (integration) => integration.tasks },
        { provide: RHINOQ_BRIDGE, inject: [RHINOQ_INTEGRATION], useFactory: (integration) => integration.bridge },
        { provide: RHINOQ_HEALTH, inject: [RHINOQ_INTEGRATION], useFactory: (integration) => integration.health.bind(integration) },
      ],
      exports: [RHINOQ_INTEGRATION, RHINOQ_TASKS, RHINOQ_BRIDGE, RHINOQ_HEALTH],
    };
  }
}

export class RhinoQLifecycle {
  constructor(integration) {
    this.integration = integration;
  }

  async onModuleInit() {
    await this.integration.start();
  }

  onModuleDestroy() {
    this.integration.close();
  }
}

async function createIntegration(options) {
  const { createRhinoQTaskIntegration } = await import('@rhinoq/node');
  return createRhinoQTaskIntegration(options);
}
