# Releasing RhinoQ

RhinoQ has published npm evaluation prereleases through
`@rhinoq/node@0.1.0-beta.2`. GitHub prerelease `v0.1.0-beta.5` successfully
published `rhinoq`/`rhinoq-agent` archives, checksums, keyless signature bundle,
per-archive SBOMs and an attested GHCR image. Its npm job failed closed because
the package does not yet grant this workflow trusted-publisher permission.
`0.1.0-beta.6` fixes npm 12 CLI-bin normalization and also attaches the
installable Node tarball to the GitHub release. Validation then found that the
legacy Cosign flags produced only a raw signature named `.bundle`; beta.7 uses
Cosign's actual `.sigstore.json` bundle and verifies its GitHub workflow
identity and OIDC issuer before the release job can pass.

## Published evaluation release

- `@rhinoq/node@0.1.0-beta.1` is the current npm `latest`.
- `@rhinoq/node@0.1.0-beta.2` is the current npm `next`.
- `v0.1.0-beta.5` is a public GitHub prerelease with Go archives and image, but
  it is not an npm registry version.
- `0.1.0-beta.7` is the corrected release candidate. Until npm publishing is
  authorized, install its exact GitHub release tarball.
- Neither prerelease implies production readiness.

Registry tags are not stability claims. Consumers must pin an explicit
prerelease. Because npm requires a `latest` tag and it currently points at the
oldest preview, move both `next` and `latest` to `beta.7` only after the clean
install check passes. The first stable release must replace them deliberately
after the public contract and production evidence are ready.

## One-time npm owner setup

1. In npm package settings, configure **trusted publishing** for the GitHub
   repository `madebyduy/RhinoQ` and workflow `.github/workflows/release.yml`.
2. Do not add a long-lived `NPM_TOKEN` to repository secrets. The tag workflow
   requests an OIDC identity and publishes with `--provenance`.
3. Protect the `v*` tag rule in GitHub so a reviewed maintainer creates tags.

These are external account actions; the repository cannot safely perform them.

## Cut a prerelease

1. Set `sdks/node/package.json` and its lockfile to the exact release version,
   for example `0.1.0-beta.7`.
2. Run from a clean checkout:

   ```bash
   go test ./...
   cd sdks/node
   npm ci
   npm test
   npm run pack:check
   npm run release:check -- v0.1.0-beta.7
   ```

3. Commit the version/docs/changelog change, then create and push the matching
   annotated tag: `v0.1.0-beta.7`.
4. The Release workflow checks the archive and matching version, then publishes
   the Node SDK to `next` and builds archives containing the `rhinoq` CLI and
   optional `rhinoq-agent` HTTP Gateway. It also verifies the checksum bundle;
   users can repeat that verification with:

   ```bash
   cosign verify-blob checksums.txt \
     --bundle checksums.txt.sigstore.json \
     --certificate-identity "https://github.com/madebyduy/RhinoQ/.github/workflows/release.yml@refs/tags/v0.1.0-beta.7" \
     --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
   ```
5. Independently verify the published artifact in a clean sample application:

   ```bash
   npm install @rhinoq/node@0.1.0-beta.7 pg
   node --input-type=module -e "import('@rhinoq/node').then(() => console.log('ok'))"
   ```

6. After that verification succeeds, move the default tag explicitly:

   ```bash
   npm dist-tag add @rhinoq/node@0.1.0-beta.7 latest
   npm dist-tag ls @rhinoq/node
   ```

If trusted publishing is not configured, the workflow must fail rather than
fall back to a token-based release.

## Do not release yet if

- the package/tag versions disagree;
- Node or Go tests fail;
- the changelog advertises unsupported BullMQ dispatch, retry/cancel or
  reconciliation behavior;
- a security release blocker is unresolved;
- the release would be presented as production-ready.
