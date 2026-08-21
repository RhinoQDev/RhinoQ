# Integration Eraser preview

Integration Eraser helps review an existing repository before adopting the
RhinoQ Task surface. It is intentionally a bounded, static scanner:

```bash
npx rhinoq adopt --scan
npx rhinoq adopt --scan --all
npx rhinoq adopt --scan --json
```

The terminal view is summary-first: use `--all` for every bounded finding or
`--json` for machine-readable evidence. The scanner honors both `.gitignore`
and an optional project `.rhinoqignore`; generated files, vendor/dependency
trees and nested repositories are excluded by default.

The scanner reads supported source files under the current directory and emits
file/line evidence for common adopter-owned glue:

- status/progress routes;
- browser or service polling timers;
- BullMQ lifecycle listeners;
- upload/request proxy code;
- retry and backoff timers.

High-confidence matches are shown as a static estimate of matching files and
lines. That number is not a deletion, savings, throughput or reliability
claim. Lower-confidence matches are marked `review` and are excluded from the
estimate. `auth`, the business handler and business verification always remain
application-owned.

The command is preview-only. It does not import or execute application code,
does not call a queue or provider, does not write or apply a patch, and has no
`--apply` mode. The schema-2 JSON report contains bounded manual-review
`preview.changes`, a unified-style `preview.diff`, and a reverse
`preview.rollback.patch` when findings exist. These are review artifacts, not
source transformations; a human must decide which matches are actually
replaceable and apply any migration patch manually.

The scan is bounded by source-file count, file size and finding count. It skips
dependency/build/test directories and redacts common inline token/secret
assignments in evidence snippets. Static absence is not proof that integration
glue is absent.
