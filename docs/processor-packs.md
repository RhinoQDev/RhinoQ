# Processor packs

Processor packs wrap repeatable specialist lifecycle around a Task handler.
The contract owns readiness inspection, cancellation inheritance, workspace
requirements, deterministic error classification, cleanup and optional metric
events. It does not own Task state, leases, retry correctness or provider
business semantics.

```ts
const ffmpeg = createRhinoQFFmpegProcessorPack({
  requiredEncoders: ['libx264'],
  requiresWorkspace: true,
});

const task = rhinoq.media('video.transcode', async (input, context) => {
  return ffmpeg.run({
    operation: 'transcode', inputPath: input.source, outputPath: context.workspace.path('video.mp4'),
  }, context);
});
```

The built-in FFmpeg pack delegates process safety and artifact registration to
the existing media context and checks the configured binary, encoders and
workspace capacity before processing. A missing dependency fails closed as a
dependency error; cancellation is not converted into a retryable success.

The current release contains the generic pack contract and FFmpeg adapter. The
exported processor catalog labels Sharp, LibreOffice, malware scanning and
AI-model entries as `provider-package-required`; that is discoverability, not a
claim that a provider implementation is bundled. Each external pack must supply
its own readiness, cleanup, resource/cost policy and semantic confirmation
contract before it is promoted to `available`.
