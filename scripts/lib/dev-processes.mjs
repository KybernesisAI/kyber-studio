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

export function belongsToCheckout(command, root) {
  return normalisePath(command).includes(checkoutMarker(root));
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
  const normalised = normalisePath(command);
  if (!normalised.includes(checkoutMarker(root))) return false;
  if (!normalised.includes(ELECTRON_DIST)) return false;
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
  const normalised = normalisePath(command);
  if (!normalised.includes(checkoutMarker(root))) return false;
  return normalised.includes(ELECTRON_DIST) || normalised.includes(PREVIEW);
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
