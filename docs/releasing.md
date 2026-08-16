# Releasing RhinoQ

RhinoQ releases one version across two npm packages and the matching GitHub
tag/release:

- `@rhinoq/node` — authoritative Node SDK and CLIs;
- `rhinoq` — unscoped compatibility alias.

`0.1.0-beta.20` is the latest verified public prerelease. `0.1.0-beta.10` was
partially published before a fan-out progress race was fixed. `0.1.0-beta.16`
published both npm packages but failed the clean CLI registry smoke before the
GitHub assets were built. Both are superseded and are not verified public
releases. A candidate is complete
only when the tag workflow has published both packages, registry smoke has
passed, the GitHub prerelease contains the Node/Go artifacts, and
provenance/signature verification has passed.

During the public beta, prereleases publish to `next` through trusted
publishing. After the full release workflow is green, a maintainer also moves
`latest` to the same verified beta so an unqualified install cannot select an
older, known-superseded beta. npm trusted publishing currently authenticates
`publish`, not `dist-tag`, so that second pointer change requires the
maintainer's interactive npm authentication. Once RhinoQ has a stable release,
`latest` will stay on stable versions and `next` will identify prereleases. A
dist-tag is an installation pointer, not a stability claim.

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
   node .github/scripts/verify-release-matrix.mjs v0.1.0-beta.20
   ```

3. Commit the candidate, then create and push the matching annotated tag:
   `v0.1.0-beta.20`.
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
   npm view @rhinoq/node@0.1.0-beta.20 version dist.integrity dist.attestations
   npm view rhinoq@0.1.0-beta.20 version dist.integrity dist.attestations
   npm dist-tag ls @rhinoq/node
   npm dist-tag ls rhinoq
   gh release view v0.1.0-beta.20
   ```

   For a public beta, each package must map `next` to the exact candidate. Only
   after every release job is green, move the default install pointer using an
   interactive maintainer session:

   ```bash
   npm dist-tag add @rhinoq/node@0.1.0-beta.20 latest
   npm dist-tag add rhinoq@0.1.0-beta.20 latest
   ```

6. Verify the keyless checksum bundle:

   ```bash
   cosign verify-blob checksums.txt \
     --bundle checksums.txt.sigstore.json \
     --certificate-identity "https://github.com/madebyduy/RhinoQ/.github/workflows/release.yml@refs/tags/v0.1.0-beta.20" \
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
