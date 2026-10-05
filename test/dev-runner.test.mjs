import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
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

/**
 * Wait until a stand-in has installed its signal handler.
 *
 * Signalling before this point measures Node's boot time rather than the
 * runner's reaping, and makes the result non-deterministic.
 */
async function ready(path, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (existsSync(path)) return true;
    await sleep(50);
  }
  return false;
}

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
function buildRig({ stubbornPlanted = false, previewParent = false } = {}) {
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

  // Ignores SIGTERM, so only the SIGKILL escalation can reap it. KYB-588 added
  // that escalation; nothing committed exercised it, because the plain planted
  // process above dies to the first TERM and the branch is never reached.
  //
  // The handler is installed BEFORE the readiness marker is written, and the
  // test waits for that marker before signalling anything. Without it there is
  // a race: the stub prints the pid the instant it spawns, while this process
  // is still booting Node and has no handler yet, so a SIGTERM arriving in
  // that window kills it by default action and the test passes for the wrong
  // reason. Measured: under a mutation that removes the SIGKILL escalation,
  // the preview test went pass / fail / fail across three runs before this.
  writeFileSync(
    join(root, "stubborn.cjs"),
    'process.on("SIGTERM", () => {});\n' +
      `require("node:fs").writeFileSync(${JSON.stringify(join(root, "stubborn.ready"))}, "y");\n` +
      "setTimeout(() => {}, 300000);\n",
  );

  // The preview parent: matches the KILL rule and not the COUNT rule, which is
  // the asymmetry KYB-589 is about. Its command line carries the literal
  // `electron-vite preview`, and its binary is NOT at the front — which is why
  // the kill rule keeps a substring test for it.
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  writeFileSync(
    join(root, "node_modules", ".bin", "electron-vite"),
    '#!/usr/bin/env node\nprocess.on("SIGTERM", () => {});\n' +
      `require("node:fs").writeFileSync(${JSON.stringify(join(root, "preview.ready"))}, "y");\n` +
      "setTimeout(() => {}, 300000);\n",
  );
  chmodSync(join(root, "node_modules", ".bin", "electron-vite"), 0o755);

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
    [${JSON.stringify(join(root, stubbornPlanted ? "stubborn.cjs" : "idle.cjs"))}],
    { stdio: "ignore" },
  );
  console.log("STUB " + process.pid);
  console.log("PLANTED " + planted.pid);
  ${
    previewParent
      ? `const preview = spawn(
    ${JSON.stringify(join(root, "node_modules", ".bin", "electron-vite"))},
    ["preview"],
    { stdio: "ignore" },
  );
  console.log("PREVIEW " + preview.pid);`
      : ""
  }
  // Deliberately no signal forwarding: the script under test must reap this.
  setTimeout(() => console.log(${JSON.stringify(LATE_LINE)}), ${LATE_DELAY_MS});
  setTimeout(() => {}, 300000);
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

test(
  "a survivor that is KILLABLE but not COUNTABLE is escalated, not passed over",
  { skip: POSIX ? false : "the rig uses a shebang stub; Windows is unverified, per KYB-588" },
  async () => {
    // KYB-589, item 1. The runner kills a wider set than it counts: the kill
    // rule takes the `electron-vite preview` parent, the count rule does not.
    // Verifying the wide kill with the narrow count meant this process
    // survived SIGTERM, never triggered the SIGKILL escalation, and the runner
    // reported a clean exit over the top of it.
    //
    // RED WHEN: the SIGKILL escalation TRIGGER in shutdown() goes back to
    // countStudio() — measured red 3 runs of 3. The preview parent then
    // survives and this fails with "the preview parent survived".
    //
    // Reverting only the VERDICT does NOT make this red, and the criterion
    // that said it would was corrected. Once the trigger is right the
    // survivor is killed either way, so nothing observable through process
    // liveness separates the two. The verdict change is still correct — it is
    // what would report a survivor that cannot be killed at all, one owned by
    // another user whose EPERM killStudio swallows — but that is unreachable
    // in this rig and is asserted by nothing here.
    const root = buildRig({ previewParent: true });
    const runner = startRunner(root);
    let planted = null;
    let stub = null;
    let preview = null;
    try {
      assert.ok(await runner.waitFor("PREVIEW", 15_000), `no preview pid:\n${runner.text()}`);
      planted = pidFrom(runner.text(), "PLANTED");
      stub = pidFrom(runner.text(), "STUB");
      preview = pidFrom(runner.text(), "PREVIEW");
      assert.ok(preview, "the rig did not report a preview pid");
      assert.ok(
        await ready(join(root, "preview.ready"), 10_000),
        "the preview parent never installed its SIGTERM handler",
      );
      assert.ok(isAlive(preview), "the preview parent was not running to begin with");

      const exited = new Promise((resolve) => runner.child.on("exit", resolve));
      runner.child.kill("SIGINT");
      assert.notEqual(await Promise.race([exited, sleep(15_000)]), undefined);

      assert.ok(
        await goneWithin(preview, 8000),
        "the preview parent survived: the runner verified with a narrower rule than it killed with",
      );
    } finally {
      for (const pid of [planted, stub, preview]) {
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

test(
  "a stale survivor from a previous run is reaped before the next one starts",
  { skip: POSIX ? false : "the rig uses a shebang stub; Windows is unverified, per KYB-588" },
  async () => {
    // clearStaleProcesses() is the other call site KYB-589 widened, and the
    // only changed path whose verdict is FATAL — it calls fail() rather than
    // shutdown()'s console.error, so a wrong answer here stops `npm run dev`
    // from starting at all. Nothing exercised it.
    //
    // The planted process is what a previous run leaves behind: killable, NOT
    // countable, and ignoring SIGTERM, so only the escalation can reap it.
    //
    // RED WHEN: the SIGKILL escalation in clearStaleProcesses() is removed, or
    // its kill is narrowed to the counted set. NOT red when its verdict alone
    // is reverted to countStudio(): by then the survivor is already dead, so
    // the two verdicts agree. That verdict differs only for a process that
    // survives SIGKILL itself — another user's, where process.kill throws
    // EPERM and killStudio swallows it — which cannot be planted here and is
    // asserted by nothing.
    const root = buildRig();
    const stale = spawn(join(root, "node_modules", ".bin", "electron-vite"), ["preview"], {
      stdio: "ignore",
    });
    let runner = null;
    let planted = null;
    let stub = null;
    try {
      assert.ok(
        await ready(join(root, "preview.ready"), 10_000),
        "the stale process never installed its SIGTERM handler",
      );
      assert.ok(isAlive(stale.pid), "the stale process was not running to begin with");

      runner = startRunner(root);
      // fail() aborts before the build, so reaching the stub at all proves the
      // sweep returned a clean verdict rather than refusing to start.
      assert.ok(
        await runner.waitFor("STUB", 20_000),
        `the runner never got past its stale sweep:\n${runner.text()}`,
      );
      planted = pidFrom(runner.text(), "PLANTED");
      stub = pidFrom(runner.text(), "STUB");

      assert.ok(
        await goneWithin(stale.pid, 8000),
        "a stale killable-but-uncountable process outlived the startup sweep",
      );
      assert.ok(
        !runner.text().includes("survived the kill"),
        `the sweep reported a survivor it had in fact reaped:\n${runner.text()}`,
      );
    } finally {
      for (const pid of [stale.pid, planted, stub]) {
        if (pid) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      }
      if (runner) runner.child.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a process that ignores SIGTERM is still reaped, by escalation",
  { skip: POSIX ? false : "the rig uses a shebang stub; Windows is unverified, per KYB-588" },
  async () => {
    // Coverage for the TERM -> verify -> KILL escalation KYB-588 added, which
    // had none: the ordinary planted process dies to the first TERM, so the
    // branch was never entered by any committed test.
    //
    // RED WHEN: the SIGKILL escalation is removed from shutdown(). Not a
    // regression test for KYB-589 itself — it passes before and after the fix,
    // because this process IS countable and so always triggered escalation.
    const root = buildRig({ stubbornPlanted: true });
    const runner = startRunner(root);
    let planted = null;
    let stub = null;
    try {
      assert.ok(await runner.waitFor("PLANTED", 15_000), `no planted pid:\n${runner.text()}`);
      planted = pidFrom(runner.text(), "PLANTED");
      stub = pidFrom(runner.text(), "STUB");
      assert.ok(
        await ready(join(root, "stubborn.ready"), 10_000),
        "the stubborn process never installed its SIGTERM handler",
      );
      assert.ok(planted && isAlive(planted), "the stubborn process was not running to begin with");

      const exited = new Promise((resolve) => runner.child.on("exit", resolve));
      runner.child.kill("SIGINT");
      assert.notEqual(await Promise.race([exited, sleep(15_000)]), undefined);

      assert.ok(
        await goneWithin(planted, 8000),
        "a process ignoring SIGTERM outlived the runner: the SIGKILL escalation did not fire",
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
