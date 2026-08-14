#!/usr/bin/env bash
# Restart the eve server and PROVE it took.
#
# Why this exists: a restart that silently fails is worse than no restart. If an
# old process survives (or a new one dies at boot), the agent keeps serving a
# stale build — new connections, instructions, and tools simply never appear,
# and every subsequent test measures yesterday's agent. This kills every eve
# process, waits for the port to actually free, starts via the CLI (which is
# what performs sandbox prewarm), and then asserts the new process started
# AFTER the build it is supposed to be serving.
#
# Two things this script learned the hard way:
#
#   1. Restarts arrive concurrently. @kybernesis/manage fires one 20s after any
#      change, and a human runs one by hand. Two overlapping runs both pass
#      their kill phase before either starts, and the result is TWO supervisors
#      and TWO servers sharing one durable store — two executors racing over the
#      same runs. That is not a slow agent, it is a corrupt one. The flock makes
#      restarts strictly serial.
#
#   2. Restarting into a live turn destroys it. The in-flight step dies with the
#      process and does not come back: the turn never emits another event, the
#      session never parks, and every later message is held behind a turn that
#      will never finish. The user sees a spinner forever. So wait for the
#      agent to be idle before killing it.
set -u
APP=/home/exedev/sid
LOG=$APP/cli.log
STORE=$APP/.eve/.workflow-data

cd "$APP" || exit 1

SERVER_MATCH=".output/server/index.mjs"

# Count ONLY real server processes.
#
# `pgrep -f <path>` matches any process whose command line contains that path —
# including the shell of whoever is watching the restart from another terminal.
# That is not hypothetical: a monitoring command containing the path failed this
# assertion and reported "2 server processes against one durable store" while
# exactly one server was running. The check meant to protect the store became
# the thing that broke the deploy.
#
# So: match the path, then keep only processes whose executable is actually node.
count_servers() {
  local n=0 pid exe
  for pid in $(pgrep -f "$SERVER_MATCH" 2>/dev/null); do
    # argv[0], not /proc/comm: node sets comm to "MainThread", so a comm check
    # counted zero servers while one was plainly running and failed the restart.
    exe=$(tr "\0" "\n" < "/proc/$pid/cmdline" 2>/dev/null | head -1)
    case "$exe" in *node) n=$((n + 1)) ;; esac
  done
  echo "$n"
}

list_servers() {
  local pid exe
  for pid in $(pgrep -f "$SERVER_MATCH" 2>/dev/null); do
    exe=$(tr "\0" "\n" < "/proc/$pid/cmdline" 2>/dev/null | head -1)
    case "$exe" in *node) echo "  $pid $(tr '\0' ' ' < /proc/$pid/cmdline)" ;; esac
  done
}


# ── Serialize. Everything below assumes it is the only restart running ──────
exec 9>/tmp/sid-restart.lock
if ! flock -w 300 9; then
  echo "FAILED: another restart held the lock for 5 minutes"
  exit 1
fi

# ── Build, if the source moved since the last one ──────────────────────────
# Restarting is not deploying. This script proved the PROCESS started after the
# BUILD, which says nothing about whether the build reflects the source — so a
# file edited ten minutes ago and a restart that reports "OK" left the agent
# serving yesterday's code, and every test after that measured the wrong agent.
#
# It matters most for the path nobody watches: @kybernesis/manage writes files
# and then calls this script. Without a build here, an install through KYBER
# Studio reports success and changes nothing.
# node_modules counts as source: eve BUNDLES dependencies into .output at
# build time, so patching an installed package changes nothing until a
# rebuild. Learned by patching a package on this host, restarting, and
# watching the old code keep serving while every timestamp said the restart
# was fine — the build was current with respect to everything it checked.
newest_source=$(find agent evals package.json node_modules/.package-lock.json \
  -newer .output/server/index.mjs -not -path '*/node_modules/*' -print -quit \
  2>/dev/null || true)
if [ -z "$newest_source" ] && [ -d node_modules/@kybernesis ]; then
  newest_source=$(find node_modules/@kybernesis -name '*.js' \
    -newer .output/server/index.mjs -print -quit 2>/dev/null || true)
fi
if [ ! -f .output/server/index.mjs ] || [ -n "$newest_source" ]; then
  echo "SOURCE IS NEWER THAN THE BUILD (${newest_source:-no build yet}) — building"
  if ! npx eve build >> "$LOG" 2>&1; then
    echo "FAILED: the build did not succeed; refusing to restart into a stale build"
    tail -20 "$LOG"
    exit 1
  fi
  echo "built"
fi

# ── Wait for in-flight turns to settle ─────────────────────────────────────
# A turnWorkflow run in `running` state is a turn someone is waiting on right
# now. Killing it strands the session. Wait, but not forever: a turn that is
# itself wedged must not block the restart that would clear it.
active_turns() {
  [ -d "$STORE/runs" ] || { echo 0; return; }
  grep -l '"workflowName":"workflow//eve//turnWorkflow"' "$STORE"/runs/*.json 2>/dev/null |
    xargs -r grep -l '"status":"running"' 2>/dev/null | wc -l
}

waited=0
while [ "$(active_turns)" != "0" ] && [ "$waited" -lt 90 ]; do
  [ "$waited" = 0 ] && echo "waiting for $(active_turns) in-flight turn(s) to settle"
  sleep 5
  waited=$((waited + 5))
done
if [ "$(active_turns)" != "0" ]; then
  echo "NOTE: restarting with $(active_turns) turn(s) still running after ${waited}s"
fi

# Kill everything eve-related. Patterns live in this file, never on an ssh
# command line, because `pkill -f` matches the ssh command itself.
pkill -f 'eve start' 2>/dev/null || true
pkill -f 'server/index.mjs' 2>/dev/null || true
sleep 6

# pgrep -c exits nonzero when the count is zero, so `|| echo 0` appended a
# SECOND zero and the comparison below could never match. Normalize instead.
still=$(count_servers)
if [ "$still" != "0" ]; then
  echo "WARNING: $still eve process(es) survived; forcing"
  pkill -9 -f 'eve start' 2>/dev/null || true
  pkill -9 -f 'server/index.mjs' 2>/dev/null || true
  sleep 4
fi

set -a
[ -f .env.local ] && . ./.env.local
set +a
: > "$LOG"
# 9>&- closes the lock descriptor for the child. Without it the server INHERITS
# the open fd and therefore holds the flock for as long as it runs, so the next
# restart blocks the full timeout and then fails — the lock meant to serialize
# restarts becomes the thing that prevents them.
setsid env PORT=8000 npx eve start --host 0.0.0.0 < /dev/null > "$LOG" 2>&1 9>&- &
sleep 45

pid=$(pgrep -f 'server/index.mjs' | head -1)
if [ -z "$pid" ]; then
  echo "FAILED to start. Last log lines:"
  tail -15 "$LOG"
  exit 1
fi

# ── Exactly one server, or the store has two writers ───────────────────────
servers=$(count_servers)
if [ "$servers" != "1" ]; then
  echo "FAILED: $servers server processes are running against one durable store"
  list_servers
  exit 1
fi

build_epoch=$(stat -c %Y .output/server/index.mjs)
proc_epoch=$(date -d "$(ps -o lstart= -p "$pid")" +%s 2>/dev/null || echo 0)
echo "pid=$pid"
echo "build: $(date -d @"$build_epoch" +%H:%M:%S)  process: $(date -d @"$proc_epoch" +%H:%M:%S)"
if [ "$proc_epoch" -ge "$build_epoch" ]; then
  echo "OK: serving the current build"
else
  echo "STALE: process predates the build — it did not restart"
  exit 1
fi
curl -s -o /dev/null -w "health: %{http_code}\n" --max-time 15 http://127.0.0.1:8000/eve/v1/health
