#!/usr/bin/env bash
# Build and run KYBER Studio, leaving exactly one app running.
#
# Why this exists: `npm run start` launches `electron-vite preview`, which spawns
# Electron as a CHILD. Killing the preview process orphans that child — macOS
# reparents it to launchd and it keeps running, holding its own window, its own
# IPC listeners, and its own connection to the agent. Four rebuilds in a row
# therefore leave four windows on screen, three of them serving stale builds
# against the same session. Watching an old window is the worst way to test a
# fix: it silently reports on code you have already replaced.
#
# `pkill -f electron` cannot be used from an interactive shell here either — the
# pattern appears in the invoking command line, so pkill matches and kills the
# caller. This resolves PIDs explicitly and skips its own process tree.
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT=$(pwd)

# Count APP processes only. Electron spawns GPU/renderer/utility helpers out of
# the same .app bundle, so a naive path match counts one running app as five and
# every assertion below becomes noise.
count_studio() {
  ps ax -o command= |
    grep -F "$ROOT/node_modules" |
    grep 'MacOS/Electron ' |
    grep -vc 'Electron Helper'
}

kill_studio() {
  local signal=$1 pids
  # Match this checkout's Electron and its vite parent, never this script.
  pids=$(ps ax -o pid=,command= |
    grep -F "$ROOT/node_modules" |
    grep -E 'electron/dist/Electron\.app|electron-vite preview' |
    awk -v self="$$" '$1 != self { print $1 }')
  [ -z "$pids" ] && return 1
  # shellcheck disable=SC2086
  kill "-$signal" $pids 2>/dev/null
  return 0
}

if kill_studio TERM; then
  sleep 2
  if kill_studio KILL; then sleep 1; fi
fi

running=$(count_studio)
if [ "$running" != "0" ]; then
  echo "FAILED: $running Studio process(es) survived the kill"
  exit 1
fi

npm run build || exit 1

LOG=${KYBER_STUDIO_LOG:-/tmp/kyber-studio.log}
: > "$LOG"
KYBER_STUDIO_DEBUG_STREAM=${KYBER_STUDIO_DEBUG_STREAM:-1} \
  nohup npm run start > "$LOG" 2>&1 &
sleep 8

# Exactly one, or the next thing anyone tests is ambiguous.
count=$(count_studio)
if [ "$count" != "1" ]; then
  echo "FAILED: expected 1 Studio process, found $count"
  tail -15 "$LOG"
  exit 1
fi
echo "OK: one Studio running, logging to $LOG"
