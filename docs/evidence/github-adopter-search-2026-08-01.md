# GitHub adopter search — 2026-08-01

Purpose: find a licensed, public BullMQ application with existing user-facing
status/progress/result plumbing where RhinoQ code deletion can be measured.

## Search and selection

GitHub repository search covered BullMQ with React progress, NestJS/PostgreSQL
and video-processing terms. Candidates had to provide:

1. an OSI-compatible license;
2. an application rather than only a queue library;
3. BullMQ workers that can remain unchanged;
4. existing user-facing lifecycle plumbing that can actually be deleted;
5. a local path that does not require paid provider credentials.

## Inspected candidate

[`taskforcesh/bullmq-video-transcoder`](https://github.com/taskforcesh/bullmq-video-transcoder)
was cloned shallow at commit `2ee8058895387ce19916a980ac6d7a29ce1267e0`.
It is MIT licensed and contains 218 TypeScript source lines with splitter,
transcoder and concat BullMQ workers.

Verdict: **not a code-reduction adopter**. It has no browser, user ownership,
status/result endpoint, polling/SSE/reconnect glue or cancellation API. Adding
RhinoQ could demonstrate worker compatibility but would necessarily add code
because there is no user-facing task plumbing to replace. Integrating it and
then claiming reduction would manufacture the result.

## Rejected candidate

[`abhinavkale-dev/fynt`](https://github.com/abhinavkale-dev/fynt) is MIT
licensed and has BullMQ, PostgreSQL, a Next.js UI and WebSocket run streaming.
It is a workflow automation platform that owns execution semantics, workers,
workflow state and realtime delivery. RhinoQ explicitly targets applications
that keep their existing runtime; replacing or duplicating Fynt's workflow
model would violate RhinoQ's product boundary and would not be a fair adopter.

## Result

No public candidate found in this search met all five gates. The repository
probe was therefore stopped before modifying third-party code. The honest next
adoption evidence still requires either:

- a public application with hand-written task lifecycle endpoints/UI; or
- a purpose-built neutral fixture whose baseline plumbing is written and
  frozen before RhinoQ integration—but that fixture must not be presented as a
  real adopter.
