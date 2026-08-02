#!/usr/bin/env bash
# Count the plumbing in an application repository, so "materially less
# plumbing" can be checked instead of asserted.
#
#   scripts/measure-plumbing.sh /path/to/app [path-inside-repo ...] > before.json
#
# Run it once before integrating RhinoQ and once after deleting what became
# dead, in the same repository. The procedure and the rules about what counts
# are in docs/measuring-plumbing.md.
#
# Counted: non-blank, non-comment lines in tracked files. Excluded: anything
# git does not track, vendored trees, lockfiles and generated output. Line
# counting is approximate by nature - it is a comparison instrument between two
# commits of one repository, not an absolute measure of anything.
set -euo pipefail

repository="${1:-}"
if [[ -z "${repository}" ]]; then
    echo "usage: $0 /path/to/app [path-inside-repo ...]" >&2
    exit 2
fi
shift || true
if [[ ! -d "${repository}/.git" ]]; then
    echo "error: ${repository} is not a git repository" >&2
    echo "hint: both counts must come from the same repository, at two commits" >&2
    exit 2
fi

cd "${repository}"

commit="$(git rev-parse HEAD)"
dirty=false
if [[ -n "$(git status --porcelain)" ]]; then
    dirty=true
fi

# Tracked files only. An untracked scratch file is not plumbing anyone ships.
mapfile -t files < <(git ls-files -- "$@" |
    grep -Ev '(^|/)(node_modules|vendor|dist|build|coverage|\.next|__generated__)/' |
    grep -Ev '\.(lock|sum|snap|min\.js|map)$' |
    grep -Ev '(^|/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum)$')

total_files=0
total_lines=0
for file in "${files[@]}"; do
    [[ -f "${file}" ]] || continue
    # Text files only: a PNG has no meaningful line count.
    if ! grep -Iq . "${file}" 2>/dev/null; then
        continue
    fi
    lines="$(sed -E 's://.*$::; s:^[[:space:]]*[#*].*$::' "${file}" |
        grep -Ev '^[[:space:]]*$' | wc -l | tr -d ' ')"
    total_files=$((total_files + 1))
    total_lines=$((total_lines + lines))
done

scope='"(whole repository)"'
if [[ $# -gt 0 ]]; then
    scope="$(printf '%s\n' "$@" | sed 's/.*/"&"/' | paste -sd, -)"
    scope="[${scope}]"
fi

cat <<JSON
{
  "repository": "$(basename "$(git rev-parse --show-toplevel)")",
  "commit": "${commit}",
  "workingTreeDirty": ${dirty},
  "scope": ${scope},
  "files": ${total_files},
  "codeLines": ${total_lines},
  "countedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "note": "Processes, datastores and credentials are counted by hand from the deployment manifests; see docs/measuring-plumbing.md."
}
JSON

if [[ "${dirty}" == "true" ]]; then
    echo "warning: working tree is dirty; the count does not correspond to ${commit}" >&2
fi
