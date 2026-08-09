import type { RhinoQTaskIntegration, RhinoQTaskIntegrationOptions } from '@rhinoq/node';
export declare const RHINOQ_OPTIONS: unique symbol;
export declare const RHINOQ_INTEGRATION: unique symbol;
export declare const RHINOQ_TASKS: unique symbol;
export declare const RHINOQ_BRIDGE: unique symbol;
export declare const RHINOQ_HEALTH: unique symbol;
export interface RhinoQModuleFactoryOptions {
  imports?: readonly unknown[];
  inject?: readonly unknown[];
  useFactory: (...dependencies: any[]) => RhinoQTaskIntegrationOptions | Promise<RhinoQTaskIntegrationOptions>;
}
export interface RhinoQDynamicModule {
  module: typeof RhinoQModule;
  imports: readonly unknown[];
  providers: readonly unknown[];
  exports: readonly unknown[];
}
export declare class RhinoQModule {
  static forRootAsync(options: RhinoQModuleFactoryOptions): RhinoQDynamicModule;
}
export declare class RhinoQLifecycle {
  constructor(integration: RhinoQTaskIntegration);
  onModuleInit(): Promise<void>;
  onModuleDestroy(): void;
}
