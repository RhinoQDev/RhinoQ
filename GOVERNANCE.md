# Governance

## Where the project is today

RhinoQ is an open source project under [Apache-2.0](./LICENSE), led by a single
maintainer. The maintainer decides releases, the public API, the schema and the
license.

This is not yet multi-party governance. It will be widened once there are
regular contributors beyond the maintainer.

## The open-core boundary

Open under Apache-2.0: the Go engine, domain, application and runtime, the
protocol, the CLI, the Node.js SDK, the documentation and the foundational
tests.

Potentially commercial: a managed hosted service, an enterprise
Console/workflow, support with an SLA, and proprietary operational automation.

Apache-2.0 does not stop anyone else from running a hosted service on the core.
The commercial value is in operating it, in the brand and in a support
commitment, not in the license — see ADR-0013 in
[`.ai/DECISIONS.md`](./.ai/DECISIONS.md).

## Merge rights

- Every change goes through a pull request.
- At least one maintainer reviews it.
- Domain, protocol, migration and security changes need two reviewers once the
  team is large enough for that to mean anything.
- A release is only cut from a commit that passed CI.
