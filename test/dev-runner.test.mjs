import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// These tests RUN scripts/dev.mjs.
//
// An earlier revision of this file did not: it spawned `node -e` with an inline
// emitter and measured Node's own pipe semantics, which meant the streaming and
// reaping criteria were credited to checks that stayed green when the script
// was reverted to the old redirect-and-tail shape. Review caught it, and it is
// this epic's recurring defect exactly — a check credited with coverage it does
// not provide. Everything below therefore drives the real script.
//
// The rig is a synthetic checkout in a temp directory: a copy of the script and
// its library, a `node_modules/electron/dist/electron` symlink standing in for
// Electron, and a stub `npm` earlier on PATH than the real one. The stub does
// NOT forward signals to the process it spawns, which is faithful: orphaned
// grandchildren are the failure this script exists to prevent, so the reaping
// must be done by the script and not by the thing it launched.

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const BURST_LINES = 40;
const LATE_LINE = "[main] window ready";
const LATE_DELAY_MS = 1200;

const POSIX = process.platform !== "win32";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function goneWithin(pid, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(50);
  }
  return !isAlive(pid);
}

/**
 * A checkout-shaped temp directory. `realpathSync` because the script resolves
 * its own root through symlinks and macOS hands out /var/folders -> /private.
 */
function buildRig() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kyb588-")));

  mkdirSync(join(root, "scripts", "lib"), { recursive: true });
  copyFileSync(join(REPO, "scripts", "dev.mjs"), join(root, "scripts", "dev.mjs"));
  copyFileSync(
    join(REPO, "scripts", "lib", "dev-processes.mjs"),
    join(root, "scripts", "lib", "dev-processes.mjs"),
  );

  // Stands in for Electron: a real binary at the real path, so `ps` reports a
  // command line the rules have to match for themselves.
  mkdirSync(join(root, "node_modules", "electron", "dist"), { recursive: true });
  symlinkSync(process.execPath, join(root, "node_modules", "electron", "dist", "electron"));
  writeFileSync(join(root, "idle.cjs"), "setTimeout(() => {}, 300000);\n");

  // Stub npm. `run build` succeeds silently; `run start` behaves like Studio —
  // a startup burst, a planted Electron, then a line after first paint.
  mkdirSync(join(root, "bin"), { recursive: true });
  const stub = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const [, , command, script] = process.argv;
if (command !== "run") process.exit(64);

if (script === "build") {
  console.log("[build] ok");
  process.exit(0);
}

if (script === "start") {
  for (let i = 1; i <= ${BURST_LINES}; i++) console.log("startup line " + i);
  const planted = spawn(
    ${JSON.stringify(join(root, "node_modules", "electron", "dist", "electron"))},
    [${JSON.stringify(join(root, "idle.cjs"))}],
    { stdio: "ignore" },
  );
  console.log("STUB " + process.pid);
  console.log("PLANTED " + planted.pid);
  // Deliberately no signal forwarding: the script under test must reap this.
  setTimeout(() => console.log(${JSON.stringify(LATE_LINE)}), ${LATE_DELAY_MS});
  setTimeout(() => {}, 300000);
  process.exit = process.exit;
}
`;
  const npmPath = join(root, "bin", "npm");
  writeFileSync(npmPath, stub);
  chmodSync(npmPath, 0o755);

  return root;
}

/** Start the real script inside the rig and stream its output back. */
function startRunner(root) {
  const child = spawn(process.execPath, [join(root, "scripts", "dev.mjs")], {
    cwd: root,
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const arrivals = [];
  const started = Date.now();
  const record = (chunk) => arrivals.push({ at: Date.now() - started, text: String(chunk) });
  child.stdout.on("data", record);
  child.stderr.on("data", record);

  const text = () => arrivals.map((arrival) => arrival.text).join("");
  const arrivalOf = (needle) => arrivals.find((arrival) => arrival.text.includes(needle));

  async function waitFor(needle, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (text().includes(needle)) return true;
      if (child.exitCode !== null) return text().includes(needle);
      await sleep(50);
    }
    return false;
  }

  return { child, arrivals, text, arrivalOf, waitFor };
}

function pidFrom(text, label) {
  const match = new RegExp(`${label} (\\d+)`).exec(text);
  return match ? Number(match[1]) : null;
}

test(
  "the runner streams its child's output, and reports the one Studio it finds",
  { skip: POSIX ? false : "the rig uses a shebang stub; Windows is unverified, per KYB-588" },
  async () => {
    const root = buildRig();
    const runner = startRunner(root);
    try {
      assert.ok(await runner.waitFor("PLANTED", 15_000), `no planted pid:\n${runner.text()}`);
      assert.ok(
        await runner.waitFor(LATE_LINE, 15_000),
        `the line printed after first paint never arrived:\n${runner.text()}`,
      );

      const text = runner.text();
      assert.ok(text.includes("startup line 1"), "the startup burst was cut off");
      assert.ok(text.includes(`startup line ${BURST_LINES}`), "the startup burst was truncated");

      // Incremental, not one flush: the old shape could not have shown the late
      // line at all, and a buffering regression would land both together.
      const burst = runner.arrivalOf("startup line 1");
      const late = runner.arrivalOf(LATE_LINE);
      assert.ok(
        late.at - burst.at >= LATE_DELAY_MS / 2,
        `expected the late line well after the burst, got ${late.at - burst.at}ms`,
      );

      // The count rule, exercised through the script against a real process
      // table rather than against a fixture.
      assert.ok(
        await runner.waitFor("one Studio running", 15_000),
        `the runner never confirmed exactly one Studio:\n${runner.text()}`,
      );
    } finally {
      runner.child.kill("SIGKILL");
      const planted = pidFrom(runner.text(), "PLANTED");
      const stub = pidFrom(runner.text(), "STUB");
      for (const pid of [planted, stub]) {
        if (pid) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "SIGINT is forwarded, and nothing the runner started survives it",
  { skip: POSIX ? false : "the rig uses a shebang stub; Windows is unverified, per KYB-588" },
  async () => {
    const root = buildRig();
    const runner = startRunner(root);
    let planted = null;
    let stub = null;
    try {
      assert.ok(await runner.waitFor("PLANTED", 15_000), `no planted pid:\n${runner.text()}`);
      planted = pidFrom(runner.text(), "PLANTED");
      stub = pidFrom(runner.text(), "STUB");
      assert.ok(planted && stub, "the rig did not report its pids");
      assert.ok(isAlive(planted), "the planted Electron was not running to begin with");

      const exited = new Promise((resolve) => runner.child.on("exit", resolve));
      runner.child.kill("SIGINT");
      assert.notEqual(await Promise.race([exited, sleep(15_000)]), undefined);

      // The stub never forwarded anything, so if the planted process is gone it
      // is because the runner swept it — which is the whole claim.
      assert.ok(await goneWithin(stub, 5000), "the runner's own child survived it");
      assert.ok(
        await goneWithin(planted, 5000),
        "an orphan survived the runner: the planted Electron is still alive",
      );
    } finally {
      for (const pid of [planted, stub]) {
        if (pid) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      }
      runner.child.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("positive control: the old redirect-sleep-tail shape loses both ends of the output", async () => {
  // A control on the SHAPE the runner replaced, not on the runner. It is what
  // makes "streaming" a claim with something to fail against: the same child,
  // sampled the old way, loses the beginning to `tail -15` and the end to a
  // fixed sample point. Scaled down so the suite stays fast; the full
  // eight-second case is run against the real script in the pull request.
  const SAMPLE_AT_MS = 200;
  const TAIL_LINES = 15;
  const emitter = `
    for (let i = 1; i <= ${BURST_LINES}; i++) console.log("startup line " + i);
    setTimeout(() => { console.log(${JSON.stringify(LATE_LINE)}); process.exit(0); }, 400);
  `;

  const logPath = join(tmpdir(), `kyb588-control-${process.pid}-${Date.now()}.log`);
  const fd = openSync(logPath, "w");
  const child = spawn(process.execPath, ["-e", emitter], { stdio: ["ignore", fd, fd] });
  let sampled;
  try {
    await sleep(SAMPLE_AT_MS);
    sampled = readFileSync(logPath, "utf8").split("\n").filter(Boolean).slice(-TAIL_LINES);
  } finally {
    child.kill("SIGKILL");
    closeSync(fd);
    rmSync(logPath, { force: true });
  }

  assert.equal(sampled.length, TAIL_LINES);
  assert.equal(sampled[0], `startup line ${BURST_LINES - TAIL_LINES + 1}`);
  assert.equal(sampled.at(-1), `startup line ${BURST_LINES}`);
  assert.ok(!sampled.includes("startup line 1"), "the old shape should have cut the first lines off");
  assert.ok(!sampled.some((line) => line.includes(LATE_LINE)), "the old shape should have missed the late line");
});
