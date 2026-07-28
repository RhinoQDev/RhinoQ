# Product research notes

These three documents are product inputs, not independent sources of truth.
Read them in this order:

1. `RHINOQ_DINH_CHINH.md` — the four-layer product correction.
2. `RHINOQ_NANG_CAP_DX.md` — DX hypotheses and future API ideas.
3. `RHINOQ_V2_CHIEN_LUOC.md` — market and sequencing research.

Canonical, implementation-backed status lives in the repository root
`README.md`, `docs/roadmap.md`, `docs/rules.md`, and
`docs/competitive-landscape.md`.

> RhinoQ is a four-layer PostgreSQL job queue: COMMIT · RUN · VERIFY · RECOVER.
> RECOVER is the fastest evaluation path, not the whole product.

Implementation status as of 2026-07-28:

- Go is the authoritative engine and CLI.
- `sdks/node` is a tested Node.js preview; it is not published to npm yet.
- `rhinoq scan`, `rhinoq introspect`, generated Rule builders, Console and
  prebuilt CLI downloads remain roadmap work.
- Commands using `npx rhinoq` or `npm install rhinoq` in historical examples
  are rejected concepts, not supported installation instructions.
- Exact onboarding times in these notes are hypotheses and measurement
  targets. They are not product promises until a reproducible usability study
  is published.

Competitor capabilities and market numbers are time-sensitive. Claims such as
“competitor X has no dashboard/workflows” or “nobody can copy this” must not be
promoted into canonical docs without dated primary-source evidence.
