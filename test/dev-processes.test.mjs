import assert from "node:assert/strict";
import test from "node:test";

import {
  belongsToCheckout,
  checkStudioCount,
  checkoutMarker,
  isHelperProcess,
  isKillableStudioProcess,
  isMainStudioProcess,
  normalisePath,
  parsePosixProcessTable,
  parseWindowsProcessTable,
  selectKillableStudioProcesses,
  selectMainStudioProcesses,
} from "../scripts/lib/dev-processes.mjs";

// Three real checkout roots, one per platform. Every fixture below is a
// command line as the platform's own process table renders it.
const LINUX_ROOT = "/home/paul/kyber-studio";
const DARWIN_ROOT = "/Users/paul/kyber-studio";
const WINDOWS_ROOT = "C:\\Users\\paul\\kyber-studio";

const LINUX = {
  main: `${LINUX_ROOT}/node_modules/electron/dist/electron .`,
  zygote: `${LINUX_ROOT}/node_modules/electron/dist/electron --type=zygote --no-zygote-sandbox`,
  gpu: `${LINUX_ROOT}/node_modules/electron/dist/electron --type=gpu-process --enable-crash-reporter`,
  renderer: `${LINUX_ROOT}/node_modules/electron/dist/electron --type=renderer --enable-sandbox`,
  utility: `${LINUX_ROOT}/node_modules/electron/dist/electron --type=utility --utility-sub-type=network.mojom.NetworkService`,
  preview: `node ${LINUX_ROOT}/node_modules/.bin/electron-vite preview`,
};

const DARWIN = {
  main: `${DARWIN_ROOT}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .`,
  gpu: `${DARWIN_ROOT}/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU) --type=gpu-process`,
  renderer: `${DARWIN_ROOT}/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer) --type=renderer`,
  utility: `${DARWIN_ROOT}/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper --type=utility --utility-sub-type=network.mojom.NetworkService`,
  preview: `node ${DARWIN_ROOT}/node_modules/.bin/electron-vite preview`,
};

const WINDOWS = {
  main: `"${WINDOWS_ROOT}\\node_modules\\electron\\dist\\electron.exe" .`,
  gpu: `"${WINDOWS_ROOT}\\node_modules\\electron\\dist\\electron.exe" --type=gpu-process`,
  renderer: `"${WINDOWS_ROOT}\\node_modules\\electron\\dist\\electron.exe" --type=renderer --enable-sandbox`,
  utility: `"${WINDOWS_ROOT}\\node_modules\\electron\\dist\\electron.exe" --type=utility --utility-sub-type=network.mojom.NetworkService`,
  preview: `node "${WINDOWS_ROOT}\\node_modules\\.bin\\electron-vite" preview`,
};

// Processes that exist on a developer's machine and are none of our business.
const FOREIGN = {
  systemElectron: "/usr/lib/electron/electron .",
  npmItself: "node /usr/lib/node_modules/npm/bin/npm-cli.js run start",
  otherApp: "/home/paul/other-app/node_modules/electron/dist/electron .",
  siblingCheckout: "/home/paul/kyber-studio-worktree/node_modules/electron/dist/electron .",
  editor: "/usr/share/code/code --type=renderer",
  // The case the acceptance criterion names: differs from the checkout root
  // ONLY in its prefix. A bare substring test matches all three, and since
  // this rule also selects pids for SIGTERM, that means killing somebody
  // else's Studio. Found by review, not by the author.
  bindMount: "/mnt/data/home/paul/kyber-studio/node_modules/electron/dist/electron .",
  backupCopy: "/srv/backup/home/paul/kyber-studio/node_modules/electron/dist/electron .",
  container:
    "/var/lib/docker/volumes/studio/_data/home/paul/kyber-studio/node_modules/electron/dist/electron .",
};

test("normalisePath folds Windows separators so one rule covers three platforms", () => {
  assert.equal(normalisePath("C:\\a\\b"), "C:/a/b");
  assert.equal(normalisePath("/a/b"), "/a/b");
});

test("checkoutMarker is this checkout's node_modules, with no trailing slash surprise", () => {
  assert.equal(checkoutMarker(LINUX_ROOT), `${LINUX_ROOT}/node_modules`);
  assert.equal(checkoutMarker(`${LINUX_ROOT}/`), `${LINUX_ROOT}/node_modules`);
  assert.equal(checkoutMarker(WINDOWS_ROOT), "C:/Users/paul/kyber-studio/node_modules");
});

test("a --type= switch marks a helper, on every platform", () => {
  for (const command of [LINUX.gpu, LINUX.renderer, LINUX.utility, LINUX.zygote]) {
    assert.equal(isHelperProcess(command), true, command);
  }
  for (const command of [DARWIN.gpu, DARWIN.renderer, DARWIN.utility]) {
    assert.equal(isHelperProcess(command), true, command);
  }
  for (const command of [WINDOWS.gpu, WINDOWS.renderer, WINDOWS.utility]) {
    assert.equal(isHelperProcess(command), true, command);
  }
  assert.equal(isHelperProcess(LINUX.main), false);
  assert.equal(isHelperProcess(DARWIN.main), false);
  assert.equal(isHelperProcess(WINDOWS.main), false);
});

test("--type= inside a path is not a switch — the main process must still count", () => {
  // Anchoring matters: an unanchored match here reports the main process as a
  // helper, the count reads zero, and the guard goes quiet exactly as the
  // shell version did.
  const command = `${LINUX_ROOT}/node_modules/electron/dist/electron --user-data-dir=/home/paul/--type=notes`;
  assert.equal(isHelperProcess(command), false);
  assert.equal(isMainStudioProcess(command, LINUX_ROOT), true);
});

test("belongsToCheckout is keyed to this checkout, not to the repo name", () => {
  assert.equal(belongsToCheckout(LINUX.main, LINUX_ROOT), true);
  assert.equal(belongsToCheckout(FOREIGN.siblingCheckout, LINUX_ROOT), false);
  assert.equal(belongsToCheckout(FOREIGN.otherApp, LINUX_ROOT), false);
  assert.equal(belongsToCheckout(FOREIGN.npmItself, LINUX_ROOT), false);
});

test("linux: exactly the main process counts", () => {
  const rows = [
    { pid: 101, command: LINUX.main },
    { pid: 102, command: LINUX.zygote },
    { pid: 103, command: LINUX.gpu },
    { pid: 104, command: LINUX.renderer },
    { pid: 105, command: LINUX.utility },
    { pid: 106, command: LINUX.preview },
    { pid: 107, command: FOREIGN.systemElectron },
    { pid: 108, command: FOREIGN.otherApp },
    { pid: 109, command: FOREIGN.siblingCheckout },
    { pid: 110, command: FOREIGN.npmItself },
    { pid: 111, command: FOREIGN.editor },
  ];
  assert.deepEqual(
    selectMainStudioProcesses(rows, LINUX_ROOT).map((row) => row.pid),
    [101],
  );
});

test("darwin: exactly the main process counts, helpers named for the bundle excluded", () => {
  const rows = [
    { pid: 201, command: DARWIN.main },
    { pid: 202, command: DARWIN.gpu },
    { pid: 203, command: DARWIN.renderer },
    { pid: 205, command: DARWIN.utility },
    { pid: 204, command: DARWIN.preview },
  ];
  assert.deepEqual(
    selectMainStudioProcesses(rows, DARWIN_ROOT).map((row) => row.pid),
    [201],
  );
});

test("win32: exactly the main process counts, through backslashes and quoting", () => {
  const rows = [
    { pid: 301, command: WINDOWS.main },
    { pid: 302, command: WINDOWS.gpu },
    { pid: 303, command: WINDOWS.renderer },
    { pid: 305, command: WINDOWS.utility },
    { pid: 304, command: WINDOWS.preview },
  ];
  assert.deepEqual(
    selectMainStudioProcesses(rows, WINDOWS_ROOT).map((row) => row.pid),
    [301],
  );
});

test("the vite preview parent is never counted as an app, on any platform", () => {
  // It carries this checkout's node_modules and no --type=, so the checkout
  // test alone admits it and one running app reads as two.
  assert.equal(isMainStudioProcess(LINUX.preview, LINUX_ROOT), false);
  assert.equal(isMainStudioProcess(DARWIN.preview, DARWIN_ROOT), false);
  assert.equal(isMainStudioProcess(WINDOWS.preview, WINDOWS_ROOT), false);
});

test("two Studios from this checkout are both counted", () => {
  const rows = [
    { pid: 101, command: LINUX.main },
    { pid: 121, command: LINUX.main },
    { pid: 102, command: LINUX.gpu },
  ];
  assert.equal(selectMainStudioProcesses(rows, LINUX_ROOT).length, 2);
});

test("killing takes the helpers and the preview parent, and nothing else", () => {
  const rows = [
    { pid: 101, command: LINUX.main },
    { pid: 102, command: LINUX.zygote },
    { pid: 103, command: LINUX.gpu },
    { pid: 106, command: LINUX.preview },
    { pid: 107, command: FOREIGN.systemElectron },
    { pid: 109, command: FOREIGN.siblingCheckout },
  ];
  assert.deepEqual(
    selectKillableStudioProcesses(rows, LINUX_ROOT).map((row) => row.pid),
    [101, 102, 103, 106],
  );
});

test("killing skips the excluded pids — our own tree", () => {
  const rows = [
    { pid: 101, command: LINUX.main },
    { pid: 106, command: LINUX.preview },
  ];
  assert.deepEqual(
    selectKillableStudioProcesses(rows, LINUX_ROOT, [106]).map((row) => row.pid),
    [101],
  );
  assert.deepEqual(selectKillableStudioProcesses(rows, LINUX_ROOT, [101, 106]), []);
});

test("posix process tables parse: leading space, and commands containing spaces", () => {
  const table = [
    "  101 " + LINUX.main,
    "99999 " + DARWIN.gpu,
    "",
    "   not a process line",
  ].join("\n");
  const rows = parsePosixProcessTable(table);
  assert.deepEqual(rows, [
    { pid: 101, command: LINUX.main },
    { pid: 99999, command: DARWIN.gpu },
  ]);
});

test("windows process tables parse, including the single-result object form", () => {
  const many = JSON.stringify([
    { ProcessId: 301, CommandLine: WINDOWS.main },
    { ProcessId: 302, CommandLine: WINDOWS.gpu },
    { ProcessId: 303, CommandLine: null },
  ]);
  assert.deepEqual(parseWindowsProcessTable(many), [
    { pid: 301, command: WINDOWS.main },
    { pid: 302, command: WINDOWS.gpu },
  ]);

  const one = JSON.stringify({ ProcessId: 301, CommandLine: WINDOWS.main });
  assert.deepEqual(parseWindowsProcessTable(one), [{ pid: 301, command: WINDOWS.main }]);

  assert.deepEqual(parseWindowsProcessTable("   "), []);
  assert.throws(() => parseWindowsProcessTable("not json"), TypeError);
});

test("a malformed table throws rather than reporting nothing is running", () => {
  // "Nothing is running" and "I could not read the table" must not look the
  // same, or the guard passes vacuously — which is precisely how the shell
  // version behaved on Linux for a month.
  //
  // Asserted on the MESSAGE, not merely on TypeError. `null.filter(...)` throws
  // a TypeError of its own, so a guard replaced by a bare `return` still turns
  // this test green while checking nothing — caught by the mutation run, and it
  // is the same shape as the finding KYB-586's review made about `includes`.
  const rowsNotArray = /process rows must be an array/;
  const rowNotObject = /each process row must be an object/;
  const rowMalformed = /each process row needs an integer pid and a string command/;

  assert.throws(() => selectMainStudioProcesses(null, LINUX_ROOT), rowsNotArray);
  assert.throws(() => selectMainStudioProcesses(undefined, LINUX_ROOT), rowsNotArray);
  assert.throws(() => selectMainStudioProcesses("101 electron", LINUX_ROOT), rowsNotArray);
  assert.throws(() => selectMainStudioProcesses([null], LINUX_ROOT), rowNotObject);
  assert.throws(() => selectMainStudioProcesses(["101 electron"], LINUX_ROOT), rowNotObject);
  assert.throws(() => selectMainStudioProcesses([{ pid: "101", command: "x" }], LINUX_ROOT), rowMalformed);
  assert.throws(() => selectMainStudioProcesses([{ pid: 1.5, command: "x" }], LINUX_ROOT), rowMalformed);
  assert.throws(() => selectMainStudioProcesses([{ pid: 101 }], LINUX_ROOT), rowMalformed);
  assert.throws(() => selectKillableStudioProcesses(null, LINUX_ROOT), rowsNotArray);
  assert.throws(() => selectKillableStudioProcesses([{ pid: 101 }], LINUX_ROOT), rowMalformed);
});

test("the count assertion is evaluated at zero, one and two", () => {
  assert.equal(checkStudioCount(0, 0).ok, true);
  assert.equal(checkStudioCount(1, 1).ok, true);

  const survived = checkStudioCount(2, 0);
  assert.equal(survived.ok, false);
  assert.equal(survived.message, "2 Studio process(es) survived the kill");

  const none = checkStudioCount(0, 1);
  assert.equal(none.ok, false);
  assert.equal(none.message, "expected 1 Studio process(es), found 0");

  const ambiguous = checkStudioCount(2, 1);
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.message, "expected 1 Studio process(es), found 2");
});

test("the count assertion refuses a nonsense count rather than passing it", () => {
  assert.throws(() => checkStudioCount(-1, 0), TypeError);
  assert.throws(() => checkStudioCount(1.5, 1), TypeError);
  assert.throws(() => checkStudioCount("1", 1), TypeError);
  assert.throws(() => checkStudioCount(1, "1"), TypeError);
});

test("the mutation this ticket names: the old macOS-only rule finds nothing on Linux", () => {
  // The shell version's predicate, transcribed. It is not a worse version of
  // the new rule — on Linux it is the zero function, which is why its "exactly
  // one" assertion passed vacuously and its kill phase matched nothing.
  //   count: grep -F "$ROOT/node_modules" | grep 'MacOS/Electron ' | grep -vc 'Electron Helper'
  //   kill:  grep -F "$ROOT/node_modules" | grep -E 'electron/dist/Electron\.app|electron-vite preview'
  const oldCount = (command, root) =>
    command.includes(`${root}/node_modules`) &&
    /MacOS\/Electron /.test(command) &&
    !command.includes("Electron Helper");
  const oldKill = (command, root) =>
    command.includes(`${root}/node_modules`) &&
    /electron\/dist\/Electron\.app|electron-vite preview/.test(command);

  assert.equal(oldCount(LINUX.main, LINUX_ROOT), false);
  assert.equal(isMainStudioProcess(LINUX.main, LINUX_ROOT), true);

  assert.equal(oldKill(LINUX.main, LINUX_ROOT), false);
  assert.equal(isKillableStudioProcess(LINUX.main, LINUX_ROOT), true);

  assert.equal(oldCount(WINDOWS.main, WINDOWS_ROOT), false);
  assert.equal(isMainStudioProcess(WINDOWS.main, WINDOWS_ROOT), true);

  // And on macOS, where it did work, the new rule agrees with it — on the
  // main process and, just as importantly, on the helpers it excluded by name.
  assert.equal(oldCount(DARWIN.main, DARWIN_ROOT), true);
  assert.equal(isMainStudioProcess(DARWIN.main, DARWIN_ROOT), true);
  assert.equal(oldCount(DARWIN.gpu, DARWIN_ROOT), false);
  assert.equal(isMainStudioProcess(DARWIN.gpu, DARWIN_ROOT), false);
  assert.equal(oldKill(DARWIN.main, DARWIN_ROOT), true);
  assert.equal(isKillableStudioProcess(DARWIN.main, DARWIN_ROOT), true);
});

test("a checkout differing only in its PREFIX is neither counted nor killed", () => {
  // The marker has to sit at a path boundary. `String.includes` alone says yes
  // to every one of these, and the consequence is not a wrong number — it is a
  // SIGTERM sent to another checkout's running Studio.
  for (const command of [FOREIGN.bindMount, FOREIGN.backupCopy, FOREIGN.container]) {
    assert.equal(belongsToCheckout(command, LINUX_ROOT), false, command);
    assert.equal(isMainStudioProcess(command, LINUX_ROOT), false, command);
    assert.equal(isKillableStudioProcess(command, LINUX_ROOT), false, command);
  }

  const rows = [
    { pid: 101, command: LINUX.main },
    { pid: 401, command: FOREIGN.bindMount },
    { pid: 402, command: FOREIGN.backupCopy },
    { pid: 403, command: FOREIGN.container },
  ];
  assert.deepEqual(
    selectMainStudioProcesses(rows, LINUX_ROOT).map((row) => row.pid),
    [101],
  );
  assert.deepEqual(
    selectKillableStudioProcesses(rows, LINUX_ROOT).map((row) => row.pid),
    [101],
  );
});

test("the boundary admits the forms a real command line actually takes", () => {
  // Start of line, after whitespace, and after a quote — and nothing else.
  assert.equal(belongsToCheckout(LINUX.main, LINUX_ROOT), true);
  assert.equal(belongsToCheckout(LINUX.preview, LINUX_ROOT), true);
  assert.equal(belongsToCheckout(WINDOWS.main, WINDOWS_ROOT), true);
  assert.equal(
    belongsToCheckout(`'${LINUX_ROOT}/node_modules/electron/dist/electron' .`, LINUX_ROOT),
    true,
  );

  // A flag VALUE pointing into our tree is somebody else's process mentioning
  // us, not us. Admitting it would widen a kill rule on a guess.
  assert.equal(
    belongsToCheckout(`/usr/lib/electron/electron --user-data-dir=${LINUX_ROOT}/node_modules/x`, LINUX_ROOT),
    false,
  );
});

test("a later occurrence still counts when an earlier one is not at a boundary", () => {
  // The scan must not stop at the first non-boundary hit: here the real path
  // follows a mention of a prefixed copy on the same command line.
  const command = `/mnt/data${LINUX_ROOT}/node_modules/x ${LINUX_ROOT}/node_modules/electron/dist/electron`;
  assert.equal(belongsToCheckout(command, LINUX_ROOT), true);
  assert.equal(isMainStudioProcess(command, LINUX_ROOT), true);
});
