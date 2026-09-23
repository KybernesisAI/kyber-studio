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

/**
 * Poll until exactly one Studio is up, streaming continuing the whole time.
 *
 * Polling rather than sleeping is the point: it reports as soon as the
 * condition holds instead of at a fixed moment chosen to be generous, and a
 * timeout is a real answer rather than a sample that happened to miss.
 */
async function reportWhenReady(child) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const count = countStudio();
    if (count === 1) {
      console.log("\n[dev] OK: one Studio running, output streaming above");
      return;
    }
    if (count > 1) {
      console.error(`\n[dev] ${checkStudioCount(count, 1).message} — the next thing you test is ambiguous`);
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  console.error(
    `\n[dev] no Studio process appeared within ${READY_TIMEOUT_MS / 1000}s — see the output above`,
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
async function shutdown(code, signal) {
  try {
    if (killStudio("SIGTERM") > 0) {
      await sleep(500);
      if (countStudio() > 0) {
        killStudio("SIGKILL");
        await sleep(300);
      }
    }
    const verdict = checkStudioCount(countStudio(), 0);
    if (!verdict.ok) console.error(`[dev] ${verdict.message}`);
  } catch (error) {
    // Reaping is best effort: never turn a clean exit into a crash.
    console.error(`[dev] could not verify clean-up: ${error.message}`);
  }
  process.exit(signal ? 1 : (code ?? 0));
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
    console.error(`\n[dev] could not confirm how many Studios are running: ${error.message}`);
  });

  child.on("error", (error) => fail(`could not run \`npm run start\`: ${error.message}`));
  child.on("exit", (code, signal) => {
    shutdown(code, signal).catch((error) => {
      console.error(`[dev] clean-up failed: ${error.message}`);
      process.exit(1);
    });
  });
}

await main();
