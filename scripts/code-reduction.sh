#!/usr/bin/env bash
# Measure what adopting RhinoQ costs and removes in a real application.
#
#   ./scripts/code-reduction.sh --repo ../api-mkt-video-scraper \
#       --before v1.4.0 --after rhinoq-integration --partner A
#
# WHY THIS IS A SCRIPT AND NOT A NUMBER
#
# docs/adoption-gap.md sets the falsification criterion for the primary
# workload — "no business-handler rewrite and materially less durable task
# plumbing" — and records that the second half is unmet: 0 lines removed,
# ~330 added. It then lists, under "What not to claim", that "the application
# gets smaller" must not be said until a real integration produces a measured
# figure.
#
# So this script does not contain a result and will not invent one. It reads
# two git refs of an adopter's own repository and prints what changed between
# them. Somebody has to point it at three real integrations before RhinoQ can
# claim anything about code reduction, and no amount of tooling here is a
# substitute for that.
#
# WHAT IT COUNTS
#
# Lines are the weakest of the four measures and the easiest to game, so it is
# reported alongside the three an operator actually feels: how many processes
# must be run, how many datastores must be operated, how many credentials must
# be issued and rotated. An integration that deletes 400 lines and adds a
# second process has not made the system smaller.
set -euo pipefail

repo="" before="" after="" partner="" output="docs/evidence"

usage() {
    cat >&2 <<'USAGE'
Usage: code-reduction.sh --repo PATH --before REF --after REF [--partner NAME]

  --repo     path to the adopter's repository (read only; never modified)
  --before   git ref before the RhinoQ integration
  --after    git ref after it
  --partner  label for the report, e.g. A, B, C. Never a company name unless
             they have given written permission — see docs/design-partners.md.
USAGE
    exit 2
}

while [ $# -gt 0 ]; do
    case "$1" in
        --repo) repo="${2:-}"; shift 2 ;;
        --before) before="${2:-}"; shift 2 ;;
        --after) after="${2:-}"; shift 2 ;;
        --partner) partner="${2:-}"; shift 2 ;;
        --output) output="${2:-}"; shift 2 ;;
        *) usage ;;
    esac
done
[ -n "$repo" ] && [ -n "$before" ] && [ -n "$after" ] || usage
[ -d "$repo/.git" ] || { echo "not a git repository: $repo" >&2; exit 1; }

in_repo() { git -C "$repo" "$@"; }

for ref in "$before" "$after"; do
    in_repo rev-parse --verify --quiet "$ref^{commit}" >/dev/null ||
        { echo "unknown ref in $repo: $ref" >&2; exit 1; }
done

# --numstat over the whole tree, then again excluding anything that looks like
# a test or a lock file. Deleting tests is not a code reduction, and a
# regenerated lockfile can swamp every real number in the diff.
read -r added removed <<EOF
$(in_repo diff --numstat "$before" "$after" |
  awk '{ a += $1; r += $2 } END { printf "%d %d", a, r }')
EOF

read -r src_added src_removed <<EOF
$(in_repo diff --numstat "$before" "$after" -- \
    ':(exclude)*test*' ':(exclude)*spec*' ':(exclude)*.lock' \
    ':(exclude)*lock.json' ':(exclude)*.snap' |
  awk '{ a += $1; r += $2 } END { printf "%d %d", a, r }')
EOF

files_changed="$(in_repo diff --name-only "$before" "$after" | wc -l | tr -d ' ')"
files_deleted="$(in_repo diff --diff-filter=D --name-only "$before" "$after" | wc -l | tr -d ' ')"

net=$((src_added - src_removed))
verdict="added ${net} net lines"
if [ "$net" -lt 0 ]; then
    verdict="removed $(( -net )) net lines"
fi

timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
label="${partner:-unlabelled}"
report="${output}/code-reduction-partner-${label}-$(date -u +%Y-%m-%d).md"
mkdir -p "$output"

cat > "$report" <<EOF
# Code reduction — design partner ${label}

Measured ${timestamp} by \`scripts/code-reduction.sh\` over \`${before}..${after}\`.
The adopter's repository was read, never modified.

## Lines

| Measure | Added | Removed | Net |
|---|---|---|---|
| Whole tree | ${added} | ${removed} | $((added - removed)) |
| Excluding tests, snapshots and lockfiles | ${src_added} | ${src_removed} | ${net} |

Files changed: ${files_changed}. Files deleted outright: ${files_deleted}.

**Line verdict: the application ${verdict}.**

## The three measures that outrank lines

These are not derivable from a diff. Fill them in with the partner during the
integration review; a blank here means the measurement is incomplete, not zero.

| Measure | Before | After |
|---|---|---|
| Processes to deploy, health-check and restart | | |
| Datastores to operate and back up | | |
| Credentials to issue and rotate | | |

## Falsification criterion

docs/adoption-gap.md requires both halves to pass:

| Half | Result |
|---|---|
| no business-handler rewrite | |
| materially less durable task plumbing | |

A net line reduction with an extra process or datastore does **not** pass the
second half. Record that outcome as a failure rather than reframing it.

## Provenance

- Repository: \`$(basename "$repo")\`
- Before: \`${before}\` ($(in_repo rev-parse --short "$before"))
- After: \`${after}\` ($(in_repo rev-parse --short "$after"))
EOF

printf 'lines added (source only)    %s\n' "$src_added"
printf 'lines removed (source only)  %s\n' "$src_removed"
printf 'net                          %s\n' "$net"
printf 'files changed                %s\n' "$files_changed"
printf '\nverdict: the application %s\n' "$verdict"
printf '\nreport written to %s\n' "$report"
printf '\nThe process, datastore and credential rows are blank on purpose.\n'
printf 'They are not derivable from a diff and must come from the partner.\n'
printf 'RhinoQ has no code-reduction claim until three of these exist.\n'
