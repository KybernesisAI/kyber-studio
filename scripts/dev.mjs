#!/usr/bin/env node
// Build and run KYBER Studio, leaving exactly one app running.
//
// Why this exists: `npm run start` launches `electron-vite preview`, which
// spawns Electron as a CHILD. Killing the preview process orphans that child —
// it keeps running, holding its own window, its own IPC listeners, and its own
// connection to the agent. Four rebuilds in a row therefore leave four windows
// on screen, three of them serving stale builds against the same session.
// Watching an old window is the worst way to test a fix: it silently reports on
// code you have already replaced.
//
// Why it is Node rather than bash: the shell version identified processes by
// the macOS `.app` bundle path, so on Linux it counted zero whatever was
// running and killed nothing — the exact failure it existed to prevent,
// silently not happening. Windows has no bash at all. The rules now live in
// scripts/lib/dev-processes.mjs as pure functions with tests; this file is the
// part that has to touch the operating system.
//
// Output STREAMS. The shell version redirected everything to a log, slept
// eight seconds, and printed the last fifteen lines, so what you saw was a
// fixed-length window onto a file sampled at a fixed moment — anything after
// first paint could be missing entirely. Two people lost time to that.

import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkStudioCount,
  parsePosixProcessTable,
  parseWindowsProcessTable,
  selectKillableStudioProcesses,
  selectMainStudioProcesses,
} from "./lib/dev-processes.mjs";

// Resolved through symlinks, because `ps` prints the path a process was
// actually executed with. A checkout reached through a symlinked home, an NFS
// /home -> /export/home, or macOS /tmp -> /private/tmp would otherwise match
// nothing: the count reads zero, the pre-launch check passes vacuously, and we
// are back to the silent-zero the shell version had on Linux.
const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const IS_WINDOWS = process.platform === "win32";
const NPM = IS_WINDOWS ? "npm.cmd" : "npm";

/** Ready when the count settles at one. Polled, not slept for. */
const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;
/**
 * How long, and across how many polls, the count has to hold at one before
 * Studio is called running. A main process that is aborting is still this
 * checkout's Electron and still not a helper, so one sighting proves only that
 * it existed for an instant. Measured (KYB-661): an Electron that fails its
 * sandbox check lives about 70 ms, and a single-sighting check called it
 * running in 11 runs of 40.
 */
const SETTLE_MS = 1_000;
const SETTLE_POLLS = 3;

/**
 * Where the launch got to: "pending" until reportWhenReady decides, then
 * "ready", "ambiguous" (more than one Studio), "timeout" or "unknown" (the
 * process table could not be read). Anything but "ready" makes the child's
 * exit a failure, since OK was never printed, and reportFailedExit says so at
 * the moment it happens: a warning printed when the poll gave up may be an
 * hour old by then.
 */
let readiness = "pending";
/** Whether a main Studio process was ever counted, for the failure message. */
let sawMainProcess = false;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function readProcessTable() {
  if (IS_WINDOWS) {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    if (result.error) throw result.error;
    return parseWindowsProcessTable(result.stdout ?? "");
  }

  const result = spawnSync("ps", ["-A", "-o", "pid=,command="], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return parsePosixProcessTable(result.stdout ?? "");
}

function countStudio() {
  return selectMainStudioProcesses(readProcessTable(), ROOT).length;
}

/**
 * How many processes a clean-up would still take — the SAME set `killStudio`
 * acts on.
 *
 * `countStudio` counts main processes only, which is right for "is one Studio
 * up?" but wrong for "did the kill work?". The kill rule deliberately reaches
 * further, to helpers and to the `electron-vite preview` parent that would
 * respawn or orphan them. Verifying the broad kill with the narrow count means
 * a survivor that is killable but not countable — the preview parent is
 * exactly that — outlives the runner and reads as a clean exit, and the next
 * run's stale sweep then reports a clean start over the top of it.
 *
 * The stale sweep still REAPS such a survivor: BOTH its gates are kills, never
 * counts, so its escalation always ran and only its verdict was narrow.
 * `shutdown()` is the one that was genuinely broken — there the escalation
 * TRIGGER was count-based too, which is why a survivor was never escalated and
 * then reported as clean.
 *
 * Two corrections to this comment are recorded because each one misled a
 * reader. It first said the sweep gated its escalation on the narrow count; a
 * reviewer believed that and concluded the change could make a stale survivor
 * fatal, which it cannot. It then said "only the two verdicts were narrow",
 * which is true of the sweep but not of this file: a reader believing it would
 * revert `shutdown()`'s trigger, the one mutation measured red three runs of
 * three.
 *
 * Own pid and parent excluded, matching `killStudio`, so the runner cannot
 * count itself as a survivor of its own clean-up.
 */
function countKillable() {
  return selectKillableStudioProcesses(readProcessTable(), ROOT, [process.pid, process.ppid])
    .length;
}

/**
 * Kill this checkout's Studio processes. Returns how many were signalled.
 *
 * Own pid and parent excluded. This is insurance rather than a known hazard:
 * npm's own command line is the global `npm-cli.js run dev` and the script
 * wrapper is `sh -c "node scripts/dev.mjs"`, neither of which carries this
 * checkout's node_modules. Cheap to keep, and it means a future change to how
 * the script is invoked cannot make it kill its own tree.
 */
function killStudio(signal) {
  const doomed = selectKillableStudioProcesses(readProcessTable(), ROOT, [
    process.pid,
    process.ppid,
  ]);
  for (const { pid } of doomed) {
    try {
      if (IS_WINDOWS) {
        spawnSync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
      } else {
        process.kill(pid, signal);
      }
    } catch {
      // Already gone between reading the table and signalling it. Expected.
    }
  }
  return doomed.length;
}

function fail(message) {
  console.error(`FAILED: ${message}`);
  process.exit(1);
}

async function clearStaleProcesses() {
  if (killStudio("SIGTERM") > 0) {
    await sleep(2000);
    if (killStudio("SIGKILL") > 0) await sleep(1000);
  }

  const verdict = checkStudioCount(countStudio(), 0);
  if (!verdict.ok) fail(verdict.message);
}

function runBuild() {
  const result = spawnSync(NPM, ["run", "build"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: IS_WINDOWS,
  });
  if (result.error) fail(`could not run \`npm run build\`: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const childHasExited = (child) => child.exitCode !== null || child.signalCode !== null;

/**
 * Poll until exactly one Studio has stayed up, streaming continuing the whole
 * time.
 *
 * Polling rather than sleeping is the point: it reports as soon as the
 * condition holds instead of at a fixed moment chosen to be generous, and a
 * timeout is a real answer rather than a sample that happened to miss.
 *
 * The condition is that the count has HELD at one, for SETTLE_MS and across
 * SETTLE_POLLS polls, with the child still alive when the line is printed.
 * Existing at one instant is not running (KYB-661). The opposite case, an
 * Electron that dies before this ever sees it, is reported by the child's exit
 * handler, because only that handler is guaranteed to run.
 */
async function reportWhenReady(child) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let heldSince = null;
  let sightings = 0;
  while (Date.now() < deadline) {
    if (childHasExited(child)) return;
    const count = countStudio();
    if (count === 1) {
      sawMainProcess = true;
      heldSince ??= Date.now();
      sightings += 1;
      const held = sightings >= SETTLE_POLLS && Date.now() - heldSince >= SETTLE_MS;
      if (held && !childHasExited(child)) {
        readiness = "ready";
        console.log("\n[dev] OK: one Studio running, output streaming above");
        return;
      }
    } else {
      heldSince = null;
      sightings = 0;
      if (count > 1) {
        readiness = "ambiguous";
        console.error(`\n[dev] ${checkStudioCount(count, 1).message} — the next thing you test is ambiguous`);
        return;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  readiness = "timeout";
  const what = sawMainProcess ? "Studio was seen but did not settle" : "no Studio process appeared";
  console.error(`\n[dev] ${what} within ${READY_TIMEOUT_MS / 1000}s - see the output above`);
}

/**
 * The child exited and OK was never printed, so this run is a failure whatever
 * the child's exit status says. That status says nothing: electron-vite runs
 * Electron with `ps.on('close', process.exit)`, so an Electron killed by a
 * signal (SIGTRAP when it fails its sandbox check) makes `npm run start` exit
 * 0 (KYB-661). Every failed exit gets a line here, at the moment it happens.
 */
function reportFailedExit(code, signal) {
  const how = signal ? `signal ${signal}` : `code ${code}`;
  if (readiness === "pending") {
    const seen = sawMainProcess
      ? "its main process was seen, then went away"
      : "its main process was never seen running";
    console.error(
      `\n[dev] FAILED: Studio aborted during startup (${seen}; \`npm run start\` exited with ${how}). ` +
        "See the output above for why.",
    );
    return;
  }
  // The poll already gave up and warned, possibly long ago. Studio may have
  // run fine since; what failed is the runner's confirmation that it did.
  const why = {
    timeout: "it did not settle within the time allowed",
    ambiguous: "more than one Studio was running",
    unknown: "the process table could not be read",
  }[readiness];
  console.error(
    `\n[dev] FAILED: \`npm run start\` exited with ${how}, and Studio was never confirmed running (${why}). ` +
      "Exiting non-zero so this run is not mistaken for a good one.",
  );
}

/**
 * The child is gone; whatever it left behind is ours to reap.
 *
 * TERM, verify, escalate to KILL, verify again — the same shape as
 * clearStaleProcesses, and for the same reason. A single TERM issued in the
 * same tick as `process.exit` is a hope, not a guarantee: the signal is
 * delivered but nothing ever looks to see whether it worked, which is how
 * stale windows survived a "clean" exit in the first place.
 */
async function shutdown(code, signal, failed = false) {
  try {
    if (killStudio("SIGTERM") > 0) {
      await sleep(500);
      if (countKillable() > 0) {
        killStudio("SIGKILL");
        await sleep(300);
      }
    }
    const verdict = checkStudioCount(countKillable(), 0);
    if (!verdict.ok) console.error(`[dev] ${verdict.message}`);
  } catch (error) {
    // Reaping is best effort: never turn a clean exit into a crash.
    console.error(`[dev] could not verify clean-up: ${error.message}`);
  }
  const status = signal ? 1 : (code ?? 0);
  process.exit(failed && status === 0 ? 1 : status);
}

async function main() {
  await clearStaleProcesses();
  runBuild();

  const child = spawn(NPM, ["run", "start"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: IS_WINDOWS,
    env: {
      ...process.env,
      KYBER_STUDIO_DEBUG_STREAM: process.env.KYBER_STUDIO_DEBUG_STREAM ?? "1",
    },
  });

  // Forward signals rather than dying and orphaning the child — the orphan
  // class this script exists to prevent, removed at its source rather than
  // cleaned up on the next run.
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      try {
        child.kill(signal);
      } catch {
        // Already exiting.
      }
    });
  }

  // Reported, never fatal. Voiding this promise instead means an unhandled
  // rejection kills the parent WITHOUT running the exit handler below, leaving
  // the child alive and reparented to init — the exact orphan this script
  // exists to prevent, re-created by its own progress reporting. Review
  // reproduced that, and the likeliest trigger is the Windows process-table
  // read, on the platform nobody has run.
  reportWhenReady(child).catch((error) => {
    readiness = "unknown";
    console.error(`\n[dev] could not confirm how many Studios are running: ${error.message}`);
  });

  child.on("error", (error) => fail(`could not run \`npm run start\`: ${error.message}`));
  child.on("exit", (code, signal) => {
    // Stopping on purpose before Studio was ready is not a failed launch.
    const failed = readiness !== "ready" && !stopping;
    if (failed) reportFailedExit(code, signal);
    shutdown(code, signal, failed).catch((error) => {
      console.error(`[dev] clean-up failed: ${error.message}`);
      process.exit(1);
    });
  });
}

await main();
