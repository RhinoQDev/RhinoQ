# Low-code upgrade status — 2026-08-14

This artifact records what is implemented in the repository and what still
needs external evidence. It is not an adopter or production benchmark.

| Tranche | Repository evidence | Status |
|---|---|---|
| Project profile | `defineRhinoQProject()`, setup manual template, composition test | implemented/tested |
| Short factories | `task`, `batch`, `media`, `effect`, `schedule`, resources and manifest tests | implemented/tested |
| Realtime/progress | WebSocket hub, SSE fallback, progress coalescer and automatic mutation invalidation hook | implemented/tested |
| Processor packs | generic lifecycle, FFmpeg adapter, Sharp-compatible provider-injected boundary and honest catalog statuses | bounded slice implemented/tested; provider evidence remains gated |
| Data path | bounded transport/multipart/workspace plus disk/GPU/region/codec admission metadata | implemented/tested |
| Integration Eraser | read-only CLI scan with confidence/evidence, diff preview and reverse patch artifact | implemented/tested |
| Evidence Passport | read-only technical/external/business projection joined into Workbench detail and endpoint | implemented/tested |
| Developer Console | Workbench Plan Inspector, Evidence Passport, Incident Explainer, Autopilot panel and operator gate | bounded slice implemented/tested |
| Selective checkpoints | opt-in Node helper, PostgreSQL schema v12, handler/input fencing, bounded state and cleanup | contract implemented/tested; Go runtime port and adopter fault drill remain |
| Autopilot | deterministic observe/recommend/simulate plus approval-bound canary executor with health gate and rollback | bounded slice implemented/tested; no Task/business mutation |
| Control Plane | boundary document only; no multi-cluster implementation | deferred |

Still required before stronger product claims:

- two real adopter before/after measurements showing net code/config/process
  reduction;
- browser acceptance in an adopter application;
- deployment-shaped fault campaign and benchmark;
- provider evidence for additional processor packs;
- design-partner pilot before any Control Plane or Autopilot auto-apply phase.
