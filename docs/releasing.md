# Releasing RhinoQ

RhinoQ releases one version across two npm packages and the matching GitHub
tag/release:

- `@rhinoq/node` — authoritative Node SDK and CLIs;
- `rhinoq` — unscoped compatibility alias.

`0.1.0-beta.11` is the latest verified public prerelease. `0.1.0-beta.10` was
partially published before a fan-out progress race was fixed, so it is
superseded and is not a verified public release. A candidate is complete
only when the tag workflow has published both packages, registry smoke has
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

Protect the `v*` tag rule so a reviewed maintainer creates release tags.

## Cut a prerelease

1. Set the exact version in the scoped SDK, its lockfile and the alias. Add the
   same heading to `CHANGELOG.md`.
2. Run from a clean checkout:

   ```bash
   go test ./...
   cd sdks/node
   npm ci
   npm test
   npm run pack:check
   cd ../..
   node .github/scripts/verify-release-matrix.mjs v0.1.0-beta.11
   ```

3. Commit the candidate, then create and push the matching annotated tag:
   `v0.1.0-beta.11`.
4. The Release workflow fails closed in this order:

   ```text
   verify matrix and archives
     -> publish @rhinoq/node
     -> publish rhinoq
     -> install exact versions from npm and smoke ESM/CJS/CLI/signatures
     -> publish GitHub assets, Go binaries and container
   ```

5. Verify the resulting state independently:

   ```bash
   npm view @rhinoq/node@0.1.0-beta.11 version dist.integrity dist.attestations
   npm view rhinoq@0.1.0-beta.11 version dist.integrity dist.attestations
   npm dist-tag ls @rhinoq/node
   npm dist-tag ls rhinoq
   gh release view v0.1.0-beta.11
   ```

   For a prerelease, each package must map `next` to the exact candidate;
   `latest` must not be moved by this workflow.

6. Verify the keyless checksum bundle:

   ```bash
   cosign verify-blob checksums.txt \
     --bundle checksums.txt.sigstore.json \
     --certificate-identity "https://github.com/madebyduy/RhinoQ/.github/workflows/release.yml@refs/tags/v0.1.0-beta.11" \
     --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
   ```

If trusted publishing, provenance, registry smoke or signature verification
fails, the release is incomplete. Do not manually move a dist-tag to hide a
failed workflow.

## Do not release if

- package, changelog and tag versions disagree;
- Node or Go acceptance fails;
- the changelog advertises behavior without code and tests;
- a security release blocker is unresolved;
- the prerelease would be presented as production-ready.
