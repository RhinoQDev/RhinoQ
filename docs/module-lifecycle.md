# RhinoQ module lifecycle

RhinoQ uses a small lifecycle boundary for replaceable runtime and processor
modules. It borrows the useful part of Caddy's module model—explicit identity,
namespace and lifecycle—without turning RhinoQ into a general plugin or
workflow DSL.

```text
loaded -> provisioned -> validated -> used -> cleaned
```

In the Node SDK, `createRhinoQModule()` supplies the lifecycle contract and
processor packs expose it as `pack.module`. Runtime adapters may expose the
same contract in their optional `module` field. `cleanup()` is idempotent and
validation cannot run before provisioning.

Provider and storage integrations can use `createRhinoQProviderComponent()`.
It deliberately returns two separate values: `declaration` is pure input for
capability linking and canonical plans, while `lifecycle` owns the explicit
imperative callbacks. Compiling or diffing a plan therefore cannot provision,
validate or clean up a provider by accident.

The boundary is intentionally narrow:

- modules may own provider handles, readiness checks, workspace cleanup and
  resource release;
- Go/runtime/Application still own leases, retries, Task state, effect
  idempotency, confirmation and recovery decisions;
- native provider packages and credentials stay application-owned;
- a module descriptor is metadata, not evidence that the provider is healthy
  or that a business outcome is correct.

This keeps extension cheap while preserving the authoritative correctness
boundary. A provider pack should be added only when it has a concrete adopter,
readiness contract, failure classification, cleanup behavior and a rollback or
disable path.

The package-composition preview is intentionally explicit:

```bash
npx rhinoq modules list
npx rhinoq modules doctor
npx rhinoq build-profile --name media-worker --with processor/ffmpeg@1.0.0
npx rhinoq build-profile --lock rhinoq-modules.lock --json
```

The resulting profile is a deterministic selected-module manifest. It does not
install dependencies, build an image or claim provider readiness. Release
tooling must add exact checksums, SBOM/provenance and target-image smoke before
calling a profile reproducible.
