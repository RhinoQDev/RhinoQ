# Releasing RhinoQ

RhinoQ has no public package or binary release yet. This guide makes the first
evaluation release repeatable without claiming production readiness.

## What a first release contains

- `@rhinoq/node@0.1.0-beta.1` under npm's `next` tag;
- Go CLI archives and checksums produced by GoReleaser from the same Git tag;
- release notes that retain the active-development warning and list known
  limitations.

The Node SDK is not `latest` until the project has a stable public contract and
production evidence.

## One-time npm owner setup

1. Create or claim the npm organization `@rhinoq` while signed into the owner
   account, then verify that `@rhinoq/node` is available before the first
   publish.
2. In npm package settings, configure **trusted publishing** for the GitHub
   repository `madebyduy/RhinoQ` and workflow `.github/workflows/release.yml`.
3. Do not add a long-lived `NPM_TOKEN` to repository secrets. The tag workflow
   requests an OIDC identity and publishes with `--provenance`.
4. Protect the `v*` tag rule in GitHub so a reviewed maintainer creates tags.

These are external account actions; the repository cannot safely perform them.

## Cut a prerelease

1. Set `sdks/node/package.json` and its lockfile to the exact release version,
   for example `0.1.0-beta.1`.
2. Run from a clean checkout:

   ```bash
   go test ./...
   cd sdks/node
   npm ci
   npm test
   npm run pack:check
   npm run release:check -- v0.1.0-beta.1
   ```

3. Commit the version/docs/changelog change, then create and push the matching
   annotated tag: `v0.1.0-beta.1`.
4. The Release workflow checks the archive and matching version, then publishes
   the Node SDK to `next` and builds the CLI archives.
5. Independently verify the published artifact in a clean sample application:

   ```bash
   npm install @rhinoq/node@0.1.0-beta.1 pg
   node --input-type=module -e "import('@rhinoq/node').then(() => console.log('ok'))"
   ```

If trusted publishing is not configured, the workflow must fail rather than
fall back to an unpublished or token-based release.

## Do not release yet if

- the package/tag versions disagree;
- Node or Go tests fail;
- the changelog advertises unsupported BullMQ dispatch, retry/cancel or
  reconciliation behavior;
- a security release blocker is unresolved;
- the release would be presented as production-ready.
