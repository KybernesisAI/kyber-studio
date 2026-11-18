#!/usr/bin/env bash
# Stop hook: before Claude ends its turn with TypeScript changes in this checkout, run both
# typechecks (main and renderer) and hand any errors back so they get fixed first. Skips when
# nothing .ts/.tsx changed, when dependencies aren't installed yet, and on the second stop in
# a row (stop_hook_active), so it can never loop.
input=$(cat)
# No jq needed: a missing jq must never turn the second stop into a third.
[[ $input =~ \"stop_hook_active\"[[:space:]]*:[[:space:]]*true ]] && exit 0
# timeout isn't on stock macOS: use it (or gtimeout) when present, else run the check directly.
to() { local s=$1; shift; if command -v timeout >/dev/null; then timeout "$s" "$@"; elif command -v gtimeout >/dev/null; then gtimeout "$s" "$@"; else "$@"; fi; }
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" || exit 0
[ -d node_modules ] || exit 0
changed=$( { git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; } | grep -E '\.(ts|tsx)$' )
[ -n "$changed" ] || exit 0
out=$( { to 70 npx --no-install tsc --noEmit -p tsconfig.node.json && to 70 npx --no-install tsc --noEmit -p tsconfig.web.json; } 2>&1) && exit 0
rc=$?
# 124 timed out, 126/127 tool missing: not a type error, so don't hold the stop.
case $rc in 124|126|127) exit 0 ;; esac
echo "Typecheck fails on your uncommitted changes; fix it before you finish:" >&2
tail -n 30 <<<"$out" >&2
exit 2
