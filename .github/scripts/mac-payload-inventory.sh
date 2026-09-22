#!/usr/bin/env bash
# TEMPORARY — KYB-550 only. Delete before merge, with the workflow that calls it.
#
# Prints what a macOS build actually carries. $1 is a label: baseline | trimmed.
#
# Decides nothing. The verdict belongs to verify-package.mjs, which classifies
# every bundled .node by the executable format it measures rather than by the
# directory it sits in. This exists so the bytes behind that verdict are visible.
#
# SIZES, corrected after review round 1. The first version of this script
# printed `du -sh` beside `stat` and labelled both `_bytes`. They are neither
# the same unit nor the same measurement:
#
#   du -sk  -> KiB of DISK USAGE (allocated blocks)
#   stat    -> BYTES of APPARENT SIZE (what a download costs)
#
# Conflating them produced a trimmed dmg reported as both 204.36 MiB and 208M.
# Both numbers are printed here, separately and labelled, so the difference can
# be read rather than guessed at. The PR body should quote apparent size: it is
# what a user downloads, and it is filesystem-independent.
set -euo pipefail

LABEL="${1:?usage: mac-payload-inventory.sh <label>}"
APP="dist/mac-arm64/KYBER Studio.app"
RES="$APP/Contents/Resources"

test -d "$APP" || { echo "::error::no .app at $APP"; exit 1; }

echo "=============================================================="
echo " KYB-550 payload inventory — $LABEL"
echo "=============================================================="

for where in "$RES/app.asar.unpacked" "$RES"; do
  [ -d "$where" ] || continue
  echo
  echo "--- onnxruntime-node prebuild directories under ${where#"$RES/"} ---"
  if find "$where" -type d -path '*onnxruntime-node/bin/napi-v6/*/*' 2>/dev/null | grep -q .; then
    find "$where" -type d -path '*onnxruntime-node/bin/napi-v6/*/*' 2>/dev/null \
      | sed "s|$where/||" | sort | while read -r d; do
          printf '  %12s bytes  %s\n' "$(find "$where/$d" -type f -exec stat -f%z {} + | awk '{s+=$1} END {print s+0}')" "$d"
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
echo "--- every bundled native library visible on disk ---"
echo "  (note: files INSIDE app.asar are not visible to a filesystem walk —"
echo "   electron-builder unpacks .node and .so but leaves .dll archived)"
find "$RES" \( -name '*.dylib' -o -name '*.so' -o -name '*.so.*' -o -name '*.dll' \) 2>/dev/null \
  | sed "s|$RES/||" | sort | sed 's/^/  /' || true

echo
echo "--- sizes, both measurements, stated in full ---"
printf '  %-14s %14s bytes apparent   %14s bytes on disk\n' "artefact" "stat -f%z" "du -sk x1024"

app_disk=$(( $(du -sk "$APP" | cut -f1) * 1024 ))
app_apparent=$(find "$APP" -type f -exec stat -f%z {} + | awk '{s+=$1} END {print s+0}')
printf '  %-14s %14s              %14s\n' "the .app" "$app_apparent" "$app_disk"

# Name the artefacts exactly rather than globbing, so a dmg and a zip sitting
# in the same directory cannot be measured as each other.
for f in dist/*.dmg dist/*.zip; do
  [ -e "$f" ] || continue
  printf '  %-14s %14s              %14s\n' \
    "$(basename "$f" | sed 's/KYBER Studio-//')" \
    "$(stat -f%z "$f")" \
    "$(( $(du -sk "$f" | cut -f1) * 1024 ))"
done

echo
echo "  machine-readable, apparent size in bytes:"
printf '    app_apparent_bytes_%s=%s\n' "$LABEL" "$app_apparent"
for f in dist/*.dmg; do
  [ -e "$f" ] && printf '    dmg_apparent_bytes_%s=%s\n' "$LABEL" "$(stat -f%z "$f")"
done
for f in dist/*.zip; do
  [ -e "$f" ] && printf '    zip_apparent_bytes_%s=%s\n' "$LABEL" "$(stat -f%z "$f")"
done
