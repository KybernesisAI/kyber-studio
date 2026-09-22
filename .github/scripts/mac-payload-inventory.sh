#!/usr/bin/env bash
# TEMPORARY — KYB-550 only. Delete before merge, with the workflow that calls it.
#
# Prints what a macOS build actually carries, in a form the two jobs can be
# compared by eye and by grep. $1 is a label: baseline | trimmed.
#
# Deliberately does NOT decide anything. The verdict belongs to
# verify-package.mjs, which already classifies every bundled .node by the
# executable format it measures rather than by the directory it sits in. This
# script exists so the bytes behind that verdict are visible in the log.
set -euo pipefail

LABEL="${1:?usage: mac-payload-inventory.sh <label>}"
APP="dist/mac-arm64/KYBER Studio.app"
RES="$APP/Contents/Resources"

test -d "$APP" || { echo "::error::no .app at $APP"; exit 1; }

echo "=============================================================="
echo " KYB-550 payload inventory — $LABEL"
echo "=============================================================="

# The prebuilds live in the unpacked tree, not inside the asar: asarUnpack
# covers @img, and electron-builder unpacks native modules it detects. Look in
# both so nothing is missed by looking in the wrong half — the mistake that
# made KYB-544's first walk read zero.
for where in "$RES/app.asar.unpacked" "$RES"; do
  [ -d "$where" ] || continue
  echo
  echo "--- onnxruntime-node prebuild directories under ${where#"$RES/"} ---"
  if find "$where" -type d -path '*onnxruntime-node/bin/napi-v6/*' -mindepth 1 2>/dev/null | grep -q .; then
    find "$where" -type d -path '*onnxruntime-node/bin/napi-v6/*/*' 2>/dev/null \
      | sed "s|$where/||" | sort | while read -r d; do
          printf '  %8s  %s\n' "$(du -sh "$where/$d" | cut -f1)" "$d"
        done
  else
    echo "  (none)"
  fi
done

echo
echo "--- every bundled .node, by path ---"
find "$RES" -name '*.node' 2>/dev/null | sed "s|$RES/||" | sort | sed 's/^/  /' || true
echo "  count: $(find "$RES" -name '*.node' 2>/dev/null | wc -l | tr -d ' ')"

echo
echo "--- every bundled native library ---"
find "$RES" \( -name '*.dylib' -o -name '*.so' -o -name '*.so.*' -o -name '*.dll' \) 2>/dev/null \
  | sed "s|$RES/||" | sort | sed 's/^/  /' || true

echo
echo "--- sizes that matter ---"
printf '  %10s  %s\n' "$(du -sh "$APP" | cut -f1)" "the .app"
for f in dist/*.dmg dist/*.zip; do
  [ -e "$f" ] && printf '  %10s  %s\n' "$(du -sh "$f" | cut -f1)" "$f"
done
echo
echo "  bytes (exact, for the before/after line in the PR body):"
printf '    app_bytes_%s=%s\n' "$LABEL" "$(du -sk "$APP" | cut -f1)"
for f in dist/*.dmg; do
  [ -e "$f" ] && printf '    dmg_bytes_%s=%s\n' "$LABEL" "$(stat -f%z "$f")"
done
