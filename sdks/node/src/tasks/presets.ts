import type { RhinoQApplicationTaskOptions } from '../runtime/application.js';
import type { RhinoQTaskEffectPolicy, RhinoQTaskRunContext } from './declaration.js';

export interface RhinoQFilePresetOptions<Input> {
  name: string;
  contentType: string;
  fileName(input: Input): string;
  generate(input: Input, context: RhinoQTaskRunContext): Promise<Uint8Array | string> | Uint8Array | string;
}

export interface RhinoQExternalPresetOptions<Input, Output> {
  name: string;
  effect: RhinoQTaskEffectPolicy;
  run(input: Input, context: RhinoQTaskRunContext): Promise<Output> | Output;
}

/** Presets remove mechanical progress/artifact wiring, never business safety. */
export const rhinoqPresets = Object.freeze({
  exportFile<Input>(options: RhinoQFilePresetOptions<Input>): RhinoQApplicationTaskOptions<Input, import('../gateway/types.js').TaskArtifact> {
    return {
      name: required(options.name, 'preset Task name'), retry: { mode: 'never' },
      async run(input, context) {
        await context.progress(0, 2, 'Generating file');
        const data = await options.generate(input, context);
        await context.progress(1, 2, 'Registering artifact');
        const artifact = await context.artifact.file(data, { name: required(options.fileName(input), 'artifact file name'), contentType: required(options.contentType, 'artifact contentType') });
        await context.progress(2, 2, 'Ready');
        return artifact;
      },
      result: (artifact) => ({ ref: artifact.id, mediaType: artifact.contentType, size: artifact.sizeBytes }),
    };
  },
  importData<Input, Output>(options: { name: string; run: RhinoQApplicationTaskOptions<Input, Output>['run'] }): RhinoQApplicationTaskOptions<Input, Output> {
    return { name: required(options.name, 'preset Task name'), retry: { mode: 'never' }, run: options.run };
  },
  external<Input, Output>(options: RhinoQExternalPresetOptions<Input, Output>): RhinoQApplicationTaskOptions<Input, Output> {
    if (!options.effect) throw new TypeError('external preset requires explicit idempotency and confirmation policy');
    return { name: required(options.name, 'preset Task name'), externalEffect: true, effect: { ...options.effect }, retry: { mode: 'never' }, run: options.run };
  },
});

function required(value: string | undefined, label: string): string {
  const result = value?.trim();
  if (!result) throw new TypeError(`${label} is required`);
  return result;
}
