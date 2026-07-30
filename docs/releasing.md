# Releasing RhinoQ

RhinoQ has published Node evaluation prereleases through
`@rhinoq/node@0.1.0-beta.2`. The repository prepares `0.1.0-beta.4`, which is
not published until a matching reviewed tag runs the release workflow. RhinoQ
still has no stable package or tagged GitHub release. The next tag is prepared
to publish both `rhinoq` and `rhinoq-agent` binaries in its archives.

## Published evaluation release

- `@rhinoq/node@0.1.0-beta.1` is the current npm `latest`.
- `@rhinoq/node@0.1.0-beta.2` is the current npm `next`.
- `0.1.0-beta.4` is a release candidate in the repository, not a registry
  version. It adds the three-table Task profile and embedded Node client on top
  of the corrected `terminalProjection`, duplicate and per-Execution contract.
- It does not imply a Go CLI archive, a GitHub release or production readiness.

Registry tags are not stability claims. Consumers must pin an explicit
prerelease. Because npm requires a `latest` tag and it currently points at the
oldest preview, move both `next` and `latest` to `beta.4` only after the clean
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
   for example `0.1.0-beta.4`.
2. Run from a clean checkout:

   ```bash
   go test ./...
   cd sdks/node
   npm ci
   npm test
   npm run pack:check
   npm run release:check -- v0.1.0-beta.4
   ```

3. Commit the version/docs/changelog change, then create and push the matching
   annotated tag: `v0.1.0-beta.4`.
4. The Release workflow checks the archive and matching version, then publishes
   the Node SDK to `next` and builds archives containing the `rhinoq` CLI and
   optional `rhinoq-agent` HTTP Gateway.
5. Independently verify the published artifact in a clean sample application:

   ```bash
   npm install @rhinoq/node@0.1.0-beta.4 pg
   node --input-type=module -e "import('@rhinoq/node').then(() => console.log('ok'))"
   ```

6. After that verification succeeds, move the default tag explicitly:

   ```bash
   npm dist-tag add @rhinoq/node@0.1.0-beta.4 latest
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
