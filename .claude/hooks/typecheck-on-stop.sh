#!/usr/bin/env bash
# Stop hook: before Claude ends its turn with TypeScript changes in this checkout, run both
# typechecks (main and renderer) and hand any errors back so they get fixed first. Skips when
# nothing .ts/.tsx changed, when dependencies aren't installed yet, and on the second stop in
# a row (stop_hook_active), so it can never loop.
input=$(cat)
[ "$(jq -r '.stop_hook_active // false' <<<"$input" 2>/dev/null)" = true ] && exit 0
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" || exit 0
[ -d node_modules ] || exit 0
changed=$( { git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; } | grep -E '\.(ts|tsx)$' )
[ -n "$changed" ] || exit 0
out=$( { timeout 70 npx --no-install tsc --noEmit -p tsconfig.node.json && timeout 70 npx --no-install tsc --noEmit -p tsconfig.web.json; } 2>&1) && exit 0
echo "Typecheck fails on your uncommitted changes; fix it before you finish:" >&2
tail -n 30 <<<"$out" >&2
exit 2
