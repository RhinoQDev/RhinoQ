# Reproducible code-reduction evidence

RhinoQ does not publish a universal LOC-saving claim. A valid comparison uses
the same report-export workload and acceptance tests for a baseline app and a
RhinoQ app, formats both normally, and excludes blank lines, comments,
generated files, tests and lockfiles.

Report frontend, backend, SQL and integration code separately. Classify each
responsibility as deleted, replaced, moved to configuration or newly required
integration code. Until the baseline directories and counting command are
checked in, README descriptions remain qualitative.

The fail-closed harness now lives at `scripts/benchmark-loc.mjs`. Configure the
two acceptance commands in `benchmarks/report-export/acceptance.json` only
after both projects exist. The script runs both suites before counting and
refuses to emit output while either side or command is missing.
