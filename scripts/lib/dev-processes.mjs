// Process-table rules for the dev runner.
//
// These are PURE FUNCTIONS over text. Nothing here spawns a process, reads the
// environment, or looks at `process.platform`. That is deliberate: the shell
// script this replaces could only be exercised by running Electron for real,
// which is why its Linux half went a month without once evaluating a non-zero
// count. Everything that decides *which* processes matter lives here, where a
// test can hand it a process table and check the answer.
//
// The caller supplies the platform-specific parts: the raw process table and
// the checkout root. See scripts/dev.mjs.

/**
 * Path separators differ across platforms and `ps` output is not normalised.
 * Compare everything in forward-slash form so one set of rules covers all
 * three platforms.
 */
export function normalisePath(text) {
  return String(text).replaceAll("\\", "/");
}

/**
 * The substring that marks a command line as belonging to THIS checkout.
 *
 * Keyed off the checkout's own `node_modules`, so a second clone of the same
 * repo running its own Studio is not ours to count or to kill. That case is not
 * hypothetical — a worktree per branch is how several of these lanes get
 * compared side by side.
 */
export function checkoutMarker(root) {
  return `${normalisePath(root).replace(/\/+$/, "")}/node_modules`;
}

/**
 * Electron's own binary, wherever it lives:
 *
 *   linux    <root>/node_modules/electron/dist/electron
 *   darwin   <root>/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
 *   win32    <root>\node_modules\electron\dist\electron.exe
 *
 * All three share `electron/dist`, and none of the surrounding tooling does.
 * The old script matched the macOS bundle path instead, which is why it found
 * nothing on Linux.
 */
const ELECTRON_DIST = "electron/dist";

/**
 * Where this checkout's Electron lives, as a path prefix.
 *
 * Every platform's binary sits under it:
 *
 *   linux    <marker>/electron/dist/electron
 *   darwin   <marker>/electron/dist/Electron.app/Contents/MacOS/Electron
 *   win32    <marker>/electron/dist/electron.exe
 *
 * as does the Linux `chrome-sandbox` zygote host, which execs the binary and
 * must still be reaped.
 */
export function checkoutElectronPrefix(root) {
  return `${checkoutMarker(root)}/${ELECTRON_DIST}`;
}

/**
 * Is this command line RUNNING this checkout's Electron, as opposed to merely
 * mentioning it?
 *
 * The rule used to be a bare `includes("electron/dist")` anywhere in the
 * string, which is true of any process that happens to name a file under that
 * directory. `vim <root>/node_modules/electron/dist/resources/default_app.asar`
 * carries this checkout's node_modules, has no `--type=`, and so was both
 * counted as a running Studio and selected for SIGTERM. So was a backup:
 * `rsync -a <root>/node_modules/electron/dist/ /backup/`. Sending SIGTERM to
 * somebody's editor is the worst thing in this file, because it destroys work
 * that has nothing to do with Studio.
 *
 * The binary must therefore be what the command line INVOKES — at the front,
 * not in an argument.
 *
 * Deliberately NOT done by splitting on whitespace and testing argv[0]. A
 * checkout root containing a space is unquoted in `ps` output, so tokenising
 * yields `/home/my` and a real Studio stops being found. Testing the prefix
 * needs no parsing and is correct for every form, spaces included.
 *
 * The prefix carries a trailing `/`, so the match is bounded at BOTH ends. A
 * bare prefix would still take a sibling directory whose name merely begins
 * with `dist` — `electron/dist-old/electron`, `dist.bak`, `distfoo` — which is
 * the same looseness this function exists to remove, one character along.
 * Every real binary has a path segment after `dist`.
 *
 * A process that merely NAMES the binary is not running it, and nor is a
 * wrapper that execs it: `sh -c '<root>/.../electron/dist/electron app'` is no
 * longer selected, because its own argv[0] is the shell. That cannot orphan a
 * Studio — the Electron process the wrapper execs has the binary at its own
 * argv[0] and is still reaped, and the wrapper exits when its child dies. The
 * one wrapper that would respawn Electron is the `electron-vite preview`
 * parent, which has its own token below.
 */
export function runsCheckoutElectron(command, root) {
  let normalised = normalisePath(command).replace(/^\s+/, "");
  // One optional opening quote: Windows quotes a path containing a space, and
  // `ps` on POSIX preserves whatever the caller used.
  if (normalised.startsWith('"') || normalised.startsWith("'")) {
    normalised = normalised.slice(1);
  }
  return normalised.startsWith(`${checkoutElectronPrefix(root)}/`);
}

/** The vite process that spawns Electron as a child, and orphans it when killed. */
const PREVIEW = "electron-vite preview";

/**
 * Electron launches every GPU, renderer, utility and zygote helper with a
 * `--type=` switch, and the main process with none. That is the discriminator:
 * structural, identical on all three platforms, and independent of how the
 * binary is laid out on disk.
 *
 * Anchored to a word boundary so a path or argument that merely CONTAINS the
 * text — `/home/me/--type=notes/` — does not silently suppress a real main
 * process and make the count read zero.
 */
export function isHelperProcess(command) {
  return /(^|\s)--type=/.test(String(command));
}

/**
 * Characters that may legitimately precede an absolute path on a command line:
 * the start of the line, whitespace, or a quote.
 *
 * Deliberately NOT `=`. A `--some-flag=/our/node_modules/...` on somebody
 * else's process would then read as ours, and this rule does not only count —
 * it selects pids for SIGTERM. Narrow is the safe direction for a kill rule.
 */
function isPathBoundary(character) {
  return character === undefined || /[\s"']/.test(character);
}

/**
 * Does this command line belong to THIS checkout?
 *
 * The marker must sit at a path boundary, not merely appear somewhere in the
 * string. A bare `includes` matches a checkout whose path differs only in its
 * PREFIX — `/mnt/data/home/paul/kyber-studio` against a root of
 * `/home/paul/kyber-studio`, or a container bind mount, or a backup copy — and
 * the first review of this change demonstrated exactly that: counted, and
 * selected for killing. The failure mode is signalling another checkout's
 * running Studio, so this is the one rule in the file that must not be loose.
 *
 * Both callers below go through here. Three inline copies of one rule means
 * three places to get this wrong, and the function the tests exercise is then
 * not the one the script runs.
 */
export function belongsToCheckout(command, root) {
  const normalised = normalisePath(command);
  const marker = checkoutMarker(root);
  let from = 0;
  for (;;) {
    const at = normalised.indexOf(marker, from);
    if (at === -1) return false;
    if (at === 0 || isPathBoundary(normalised[at - 1])) return true;
    from = at + 1;
  }
}

/**
 * A main Studio process: this checkout's Electron binary, with no `--type=`.
 *
 * Note both halves are load-bearing. Without the `electron/dist` test the
 * `electron-vite preview` parent and the `npm` wrapper above it both qualify —
 * they carry this checkout's node_modules and no `--type=` — and one running
 * app counts as three.
 */
export function isMainStudioProcess(command, root) {
  if (!belongsToCheckout(command, root)) return false;
  if (!runsCheckoutElectron(command, root)) return false;
  return !isHelperProcess(command);
}

/**
 * Everything a clean-up should remove: this checkout's Electron processes,
 * helpers included, plus the vite preview parent that would respawn or orphan
 * them. Broader than the counting rule on purpose — killing the main process
 * usually takes its helpers with it, but "usually" is what left stale windows
 * on screen in the first place.
 */
export function isKillableStudioProcess(command, root) {
  if (!belongsToCheckout(command, root)) return false;
  // The preview parent stays a substring test. Its command line is
  // `<interpreter> <root>/node_modules/.bin/electron-vite preview`, so the
  // binary is not at the front and a prefix rule would stop matching it. The
  // token carries its own space and is specific enough not to collide.
  return runsCheckoutElectron(command, root) || normalisePath(command).includes(PREVIEW);
}

/**
 * Parse `ps -A -o pid=,command=` output: leading whitespace, pid, whitespace,
 * then the command line, which itself contains whitespace and must not be split.
 */
export function parsePosixProcessTable(text) {
  const rows = [];
  for (const line of String(text).split("\n")) {
    const match = /^\s*(\d+)\s+(\S.*)$/.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), command: match[2] });
  }
  return rows;
}

/**
 * Parse the JSON emitted by
 *   Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json
 *
 * PowerShell serialises a single result as an object rather than a one-element
 * array, and reports a null CommandLine for processes it cannot read — both of
 * which are ordinary, not errors.
 */
export function parseWindowsProcessTable(text) {
  const trimmed = String(text).trim();
  if (trimmed === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new TypeError("process table is not valid JSON");
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const rows = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const pid = Number(entry.ProcessId);
    if (!Number.isInteger(pid)) continue;
    if (typeof entry.CommandLine !== "string") continue;
    rows.push({ pid, command: entry.CommandLine });
  }
  return rows;
}

function assertRows(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError("process rows must be an array");
  }
  for (const row of rows) {
    if (row === null || typeof row !== "object") {
      throw new TypeError("each process row must be an object");
    }
    if (!Number.isInteger(row.pid) || typeof row.command !== "string") {
      throw new TypeError("each process row needs an integer pid and a string command");
    }
  }
}

/**
 * A malformed table throws rather than answering zero.
 *
 * "Nothing is running" and "I could not read the process table" must not
 * produce the same answer, or the guard goes quiet exactly when something has
 * gone wrong — which is the failure this whole ticket is about, one level along.
 */
export function selectMainStudioProcesses(rows, root) {
  assertRows(rows);
  return rows.filter((row) => isMainStudioProcess(row.command, root));
}

/**
 * Killable processes, minus this script's own tree.
 *
 * The shell version needed this because its own `grep` pattern appeared in its
 * own command line and it would otherwise kill itself. The Node version is not
 * self-matching, but `npm run dev` puts a wrapper in the table that carries
 * this checkout's node_modules, so exclusion still matters.
 */
export function selectKillableStudioProcesses(rows, root, excludedPids = []) {
  assertRows(rows);
  const excluded = new Set(excludedPids.filter((pid) => Number.isInteger(pid)));
  return rows.filter(
    (row) => !excluded.has(row.pid) && isKillableStudioProcess(row.command, root),
  );
}

/**
 * The guarantee the script exists to provide, as a value rather than a branch:
 * exactly `expected` Studio processes, or an explanation of what was found.
 *
 * Returned rather than printed so a test can evaluate it at zero, one and two.
 * The shell version was an inline `if` that, on Linux, only ever saw zero.
 */
export function checkStudioCount(count, expected) {
  if (!Number.isInteger(count) || count < 0) {
    throw new TypeError("count must be a non-negative integer");
  }
  if (!Number.isInteger(expected) || expected < 0) {
    throw new TypeError("expected must be a non-negative integer");
  }
  if (count === expected) {
    return { ok: true, count, expected, message: `${count} Studio process(es), as expected` };
  }
  if (expected === 0) {
    return {
      ok: false,
      count,
      expected,
      message: `${count} Studio process(es) survived the kill`,
    };
  }
  return {
    ok: false,
    count,
    expected,
    message: `expected ${expected} Studio process(es), found ${count}`,
  };
}
