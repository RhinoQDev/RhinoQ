# Releasing RhinoQ

RhinoQ releases one version across three npm packages and the matching GitHub
tag/release:

- `@rhinoq/node` — authoritative Node SDK and CLIs;
- `rhinoq` — unscoped compatibility alias;
- `create-rhinoq-app` — one-command evaluation app.

`0.1.0-beta.10` is the current source candidate. Its tag exists, but the
publish workflow is incomplete, so it is not yet a verified public release.
`0.1.0-beta.8` is the latest verified public release. A candidate is complete
only when the tag workflow has published all three packages, registry smoke has
passed, the GitHub prerelease contains the Node/Go artifacts, and
provenance/signature verification has passed.

Prereleases publish to `next`; stable versions publish to `latest`. A dist-tag
is an installation pointer, not a stability claim.

## One-time npm owner setup

In npm package settings, configure trusted publishing for repository
`madebyduy/RhinoQ` and workflow `release.yml` for `@rhinoq/node` and `rhinoq`.
The workflow uses this GitHub OIDC path exclusively for those two packages;
npm generates provenance automatically for trusted publishes. Remove the
`NPM_BOOTSTRAP_TOKEN` GitHub secret before retrying the release. A normal
granular token without 2FA bypass cannot work in a non-interactive runner: npm
will stop with `EOTP` and wait for a one-time password.

The first publication of `create-rhinoq-app` is the one exception: npm requires
a package to exist before trusted publishing can be configured. Create an
expiring granular write token with **2FA bypass enabled** and store it
temporarily as `NPM_CREATE_APP_BOOTSTRAP_TOKEN`. The workflow uses it only if
the package does not exist yet. Immediately after the first successful
publication, configure the trusted publisher for `create-rhinoq-app`, delete
the secret and revoke the token. If the package already exists, the workflow
always uses OIDC and ignores that secret.

Protect the `v*` tag rule so a reviewed maintainer creates release tags.

## Cut a prerelease

1. Set the exact version in the scoped SDK, its lockfile, the alias, the
   scaffolder and the generated template dependency. Add the same heading to
   `CHANGELOG.md`.
2. Run from a clean checkout:

   ```bash
   go test ./...
   cd sdks/node
   npm ci
   npm test
   npm run pack:check
   cd ../create-rhinoq-app
   npm ci
   npm test
   cd ../..
   node .github/scripts/verify-release-matrix.mjs v0.1.0-beta.10
   ```

3. Commit the candidate, then create and push the matching annotated tag:
   `v0.1.0-beta.10`.
4. The Release workflow fails closed in this order:

   ```text
   verify matrix and archives
     -> publish @rhinoq/node
     -> publish rhinoq
     -> publish create-rhinoq-app
     -> install exact versions from npm and smoke ESM/CJS/CLI/scaffold/signatures
     -> publish GitHub assets, Go binaries and container
   ```

5. Verify the resulting state independently:

   ```bash
   npm view @rhinoq/node@0.1.0-beta.10 version dist.integrity dist.attestations
   npm view rhinoq@0.1.0-beta.10 version dist.integrity dist.attestations
   npm view create-rhinoq-app@0.1.0-beta.10 version dist.integrity dist.attestations
   npm dist-tag ls @rhinoq/node
   npm dist-tag ls rhinoq
   npm dist-tag ls create-rhinoq-app
   gh release view v0.1.0-beta.10
   ```

   For a prerelease, each package must map `next` to the exact candidate;
   `latest` must not be moved by this workflow.

6. Verify the keyless checksum bundle:

   ```bash
   cosign verify-blob checksums.txt \
     --bundle checksums.txt.sigstore.json \
     --certificate-identity "https://github.com/madebyduy/RhinoQ/.github/workflows/release.yml@refs/tags/v0.1.0-beta.10" \
     --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
   ```

If trusted publishing, provenance, registry smoke or signature verification
fails, the release is incomplete. Do not manually move a dist-tag to hide a
failed workflow.

## Do not release if

- package, template, changelog and tag versions disagree;
- Node, Go, scaffold or browser acceptance fails;
- the changelog advertises behavior without code and tests;
- a security release blocker is unresolved;
- the prerelease would be presented as production-ready.
