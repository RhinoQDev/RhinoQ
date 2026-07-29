# Releasing RhinoQ

RhinoQ has published the Node evaluation prerelease
`@rhinoq/node@0.1.0-beta.1`. It has no stable package, tagged GitHub release or
public CLI binary release yet. This guide keeps subsequent evaluation releases
repeatable without claiming production readiness.

## Published evaluation release

- `@rhinoq/node@0.1.0-beta.1` is published on npm; consumers must pin the
  exact version while the public contract remains unstable.
- It does not imply a Go CLI archive, a GitHub release or production readiness.

The npm registry currently resolves `latest` to this first published version.
That is a registry tag, not a stability claim: documentation and consumers
must pin the explicit prerelease or use `next` until a stable public contract
and production evidence exist. The first stable release must deliberately move
`latest` to its stable version.

## One-time npm owner setup

1. In npm package settings, configure **trusted publishing** for the GitHub
   repository `madebyduy/RhinoQ` and workflow `.github/workflows/release.yml`.
2. Do not add a long-lived `NPM_TOKEN` to repository secrets. The tag workflow
   requests an OIDC identity and publishes with `--provenance`.
3. Protect the `v*` tag rule in GitHub so a reviewed maintainer creates tags.

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
fall back to a token-based release.

## Do not release yet if

- the package/tag versions disagree;
- Node or Go tests fail;
- the changelog advertises unsupported BullMQ dispatch, retry/cancel or
  reconciliation behavior;
- a security release blocker is unresolved;
- the release would be presented as production-ready.
