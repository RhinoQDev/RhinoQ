# Pilot optimization contract — 2026-08-14

This file records repository-level evidence for the Phase D slices. It is not
an adopter performance claim.

| Work package | Implemented slice | Proof | Not yet proven |
|---|---|---|---|
| P1-08 | opt-in checkpoint helper, PostgreSQL schema v12, version/checksum fence, 64 KiB state bound, idempotent identical replay and cleanup | `sdks/node/test/task-checkpoint.test.mjs`, Node typecheck/build | SIGKILL/resume drill on a real adopter workload, retention/cleanup operations and Go runtime port review |
| P2-01 | explicit approval, bounded task count/window, application-owned apply/observe hooks, reverse rollback on failed health gate | `sdks/node/test/autopilot.test.mjs` | design-partner canary, automatic stop-condition drill, before/after SLO/cost evidence |
| P2-02 | provider-injected Sharp-compatible boundary; no native image package added to core | `sdks/node/test/processor-pack.test.mjs` | provider version matrix, resource/fault benchmark, non-root container and adopter support policy |
| P2-03 | decision record keeps Control Plane deferred and defines re-entry gates | `docs/evidence/control-plane-gate-2026-08-14.md` | multi-cluster bottleneck and adopter demand evidence |

## Safety boundary

None of these slices moves leases, retries, effects, Task state transitions or
business correctness into Node. Checkpoints are resumable handler state, not a
claim that an external effect succeeded. Autopilot executes only application-
owned settings after an approval; an unhealthy observation triggers the
application rollback hook. Processor providers remain optional and must supply
their own readiness, resource and security evidence.

**Evidence level:** L1 repository evidence. Controlled-pilot and production
claims remain gated by the canonical upgrade plan.
