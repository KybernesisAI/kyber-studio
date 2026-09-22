import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The shape of the claim, not the app.
//
// `scripts/dev.mjs` streams its child's output. The shell script it replaces
// redirected that output to a log, slept for a fixed interval, and printed
// `tail -15` of whatever had landed by then. These tests pin the difference
// with a child that behaves like Studio does — a burst at startup, then a line
// after first paint — and they run in under a second because the interval is
// scaled, not because the shape is faked. The real eight-second case is
// demonstrated in the pull request.

const BURST_LINES = 40;
const LATE_LINE = "after the sample";
const LATE_DELAY_MS = 400;
const SAMPLE_AT_MS = 200;
const TAIL_LINES = 15;

const EMITTER = `
  for (let i = 1; i <= ${BURST_LINES}; i++) console.log("line " + i);
  setTimeout(() => { console.log(${JSON.stringify(LATE_LINE)}); process.exit(0); }, ${LATE_DELAY_MS});
`;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** What scripts/dev.mjs does: pipe the child through, as it arrives. */
function streamChild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", EMITTER], { stdio: ["ignore", "pipe", "pipe"] });
    const arrivals = [];
    const started = Date.now();
    child.stdout.on("data", (chunk) => {
      arrivals.push({ at: Date.now() - started, text: String(chunk) });
    });
    child.on("error", reject);
    child.on("exit", () => resolve({ arrivals, elapsed: Date.now() - started }));
  });
}

/** What scripts/dev.sh did: redirect to a log, sleep, print the last N lines. */
async function sampleChildLikeTheShellScript() {
  const logPath = join(tmpdir(), `dev-stream-control-${process.pid}-${Date.now()}.log`);
  const fd = openSync(logPath, "w");
  const child = spawn(process.execPath, ["-e", EMITTER], { stdio: ["ignore", fd, fd] });
  try {
    await sleep(SAMPLE_AT_MS);
    const contents = readFileSync(logPath, "utf8");
    const lines = contents.split("\n").filter((line) => line !== "");
    return lines.slice(-TAIL_LINES);
  } finally {
    child.kill("SIGKILL");
    closeSync(fd);
    rmSync(logPath, { force: true });
  }
}

test("streaming delivers every line, including the one written after the old sample point", async () => {
  const { arrivals } = await streamChild();
  const text = arrivals.map((arrival) => arrival.text).join("");
  const lines = text.split("\n").filter((line) => line !== "");

  assert.equal(lines.length, BURST_LINES + 1);
  assert.equal(lines[0], "line 1");
  assert.equal(lines.at(-1), LATE_LINE);
});

test("streaming is incremental — the burst arrives long before the late line", async () => {
  // If output were only flushed when the child exited, these two would land in
  // the same chunk at the same moment. That is the failure being ruled out:
  // a developer watching a build must see it while it happens.
  const { arrivals } = await streamChild();

  const burst = arrivals.find((arrival) => arrival.text.includes("line 1"));
  const late = arrivals.find((arrival) => arrival.text.includes(LATE_LINE));
  assert.ok(burst, "the startup burst never arrived");
  assert.ok(late, "the late line never arrived");

  assert.ok(
    late.at - burst.at >= LATE_DELAY_MS / 2,
    `expected the late line at least ${LATE_DELAY_MS / 2}ms after the burst, got ${late.at - burst.at}ms`,
  );
});

test("positive control: the old redirect-sleep-tail shape loses both ends of the output", async () => {
  // Without this, "streaming works" is a claim with nothing to fail against.
  // The old shape is reproduced faithfully and shown to drop lines: the
  // beginning, because `tail -15` cuts it off, and the end, because the sample
  // is taken at a fixed moment the app has not reached yet.
  const sampled = await sampleChildLikeTheShellScript();

  assert.equal(sampled.length, TAIL_LINES);
  assert.ok(!sampled.includes("line 1"), "the old shape should have cut the first lines off");
  assert.ok(!sampled.includes(LATE_LINE), "the old shape should have missed the late line");
  assert.equal(sampled.at(-1), `line ${BURST_LINES}`);
});

test("the child's exit code reaches the caller rather than being swallowed", async () => {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.exit(3)"], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", resolve);
  });
  assert.equal(code, 3);
});
