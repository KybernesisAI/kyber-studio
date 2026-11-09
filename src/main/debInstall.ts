/**
 * Installing a downloaded `.deb` update (KYB-670).
 *
 * This replaces the install step of electron-updater's `DebUpdater` (6.8.9),
 * which got three things wrong on a Debian-family desktop, all measured in the
 * KYB-608 UAT on Linux Mint 22.3 MATE:
 *
 * 1. **It judged the result by exit codes.** `dpkg -i` ran behind a password
 *    prompt; if that threw for ANY reason, a cancelled prompt included, it ran
 *    `apt-get install -f -y`, and a zero exit from that counted as installed.
 *    On a healthy system `apt-get install -f` has nothing to fix and exits 0, so
 *    cancelling the first prompt and approving the second restarted Studio as
 *    if updated, on the old version, with no error anywhere.
 * 2. **The prompt never named Studio.** It ran `pkexec /bin/bash -c '<command>'`,
 *    so polkit showed its generic "run a program as another user" text, quoting
 *    a shell command and a path in the person's home directory.
 * 3. **A cancel asked again**, first for the broader `apt-get` command, then
 *    twice more at quit: four root-password dialogs for one declined update.
 *
 * So here:
 *
 * - **The installed version decides.** After the install, whatever any command
 *   exited with, `dpkg-query` must report the downloaded package's own version
 *   with the package fully installed (`ii`). Nothing else counts as success.
 *   The expected version is read from the `.deb` itself with `dpkg-deb`, so it
 *   is spelt exactly as dpkg spells it, whatever the release tag looked like.
 * - **One prompt, naming Studio.** The install runs as `pkexec <helper> <deb>`.
 *   The helper ships in the package, and a polkit action in the package points
 *   at it (`org.freedesktop.policykit.exec.path`), so the dialog shows that
 *   action's message instead of a command line. The helper does the dependency
 *   fix-up itself, only when `dpkg` really left the package unconfigured, under
 *   the same single authorisation.
 * - **A cancel ends it.** There is no second command to fall back to. The
 *   caller also stops install-on-quit for the session (see `updater.ts`).
 *
 * Everything here is synchronous because electron-updater's `install` is: its
 * quit handler cannot await. Nothing in this file imports Electron, so the
 * decisions can be driven directly from a test through `run` and `exists`.
 */

import { spawnSync } from "node:child_process";

/** Where the package installs the helper. Must match `deb.fpm` in package.json. */
export const DEB_UPDATE_HELPER = "/usr/lib/kyber-studio/kyber-studio-update";

/**
 * The programs, by absolute path. On Debian and Ubuntu all three live in
 * /usr/bin. `dpkg-query` makes the success decision, `dpkg-deb` supplies the
 * version it is compared with, and `pkexec` asks for the password.
 *
 * An absolute path chooses only the program itself: `dpkg-deb -f` runs `tar`,
 * found through PATH. Studio's inherited PATH is not trusted for that either
 * (Ubuntu puts `~/.local/bin` first, so a planted `tar` could forge the
 * expected version and make a cancelled install read as installed), so
 * `systemRun` replaces it with `SYSTEM_PATH`.
 */
export const PKEXEC = "/usr/bin/pkexec";
export const DPKG_DEB = "/usr/bin/dpkg-deb";
export const DPKG_QUERY = "/usr/bin/dpkg-query";

/** The only PATH the install's commands see, whatever Studio inherited. */
export const SYSTEM_PATH = "/usr/sbin:/usr/bin:/sbin:/bin";

/** The format `readInstalled` asks dpkg-query for: version, a tab, the three-letter status. */
export const INSTALLED_FORMAT = "-f=${Version}\\t${db:Status-Abbrev}";

/** The package name dpkg knows Studio by: the npm `name`, not `productName`. */
export const DEB_PACKAGE = "kyber-studio";

/** What a synchronous spawn reports. `error` is set when the program could not be started at all. */
export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: { code?: string; message: string };
}

export type Run = (command: string, args: string[]) => RunResult;

/**
 * The real `Run`: synchronous, with no shell, and with PATH fixed to
 * `SYSTEM_PATH` for the command and everything it starts. No shell matters
 * because the path to the download contains the person's home directory, and
 * is passed as a single argument, unquoted and unescaped.
 */
export const systemRun: Run = (command, args) => {
  const r = spawnSync(command, args, { encoding: "utf-8", env: { ...process.env, PATH: SYSTEM_PATH } });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error ? { code: (r.error as NodeJS.ErrnoException).code, message: r.error.message } : undefined,
  };
};

export interface DebInstallInput {
  /** The downloaded `.deb`, as an absolute path. Passed as one argument, never through a shell. */
  debPath: string;
  /** True when Studio itself runs as root, which needs no prompt. */
  isRoot: boolean;
  run: Run;
  exists: (path: string) => boolean;
  helperPath?: string;
}

export type DebInstallReason =
  | "declined" // pkexec 126: the person dismissed the prompt
  | "not-authorised" // pkexec 127: wrong password, not allowed, or no polkit agent
  | "no-pkexec" // pkexec is not installed
  | "no-helper" // the helper is missing from this installation
  | "not-our-package" // the download is not a kyber-studio package
  | "unreadable" // dpkg-deb could not read the download
  | "failed"; // the install ran, and the version it was meant to install is not installed

export type DebInstallResult =
  | { installed: true; version: string }
  | { installed: false; reason: DebInstallReason; expected: string | null; found: string | null; detail: string };

/** Reads `Package` and `Version` from the downloaded file. */
function readPackage(run: Run, debPath: string): { name: string; version: string } | null {
  const r = run(DPKG_DEB, ["-f", debPath, "Package", "Version"]);
  if (r.error || r.status !== 0) return null;
  const field = (key: string): string | null => {
    const m = new RegExp(`^${key}:\\s*(\\S+)\\s*$`, "m").exec(r.stdout);
    return m ? m[1] : null;
  };
  const name = field("Package");
  const version = field("Version");
  return name && version ? { name, version } : null;
}

/**
 * What dpkg reports for Studio right now: its version, and whether it is fully
 * installed. `null` when it is not known to dpkg at all.
 */
export function readInstalled(run: Run): { version: string; ok: boolean } | null {
  // `${db:Status-Abbrev}` is three characters, e.g. "ii " for installed and
  // configured, "iU " for unpacked but not configured, "iF " for half-configured.
  const r = run(DPKG_QUERY, ["-W", INSTALLED_FORMAT, DEB_PACKAGE]);
  if (r.error || r.status !== 0) return null;
  const [version, abbrev = ""] = r.stdout.trim().split("\t");
  if (!version) return null;
  return { version, ok: abbrev.trim() === "ii" };
}

function describe(r: RunResult): string {
  if (r.error) return r.error.message;
  const tail = r.stderr.trim().split("\n").slice(-3).join(" ").trim();
  return `exited with ${r.status}${tail ? `: ${tail}` : ""}`;
}

export function installDebUpdate(input: DebInstallInput): DebInstallResult {
  const { debPath, isRoot, run, exists } = input;
  const helper = input.helperPath ?? DEB_UPDATE_HELPER;
  const notInstalled = (
    reason: DebInstallReason,
    expected: string | null,
    found: string | null,
    detail: string,
  ): DebInstallResult => ({ installed: false, reason, expected, found, detail });

  const pkg = readPackage(run, debPath);
  if (!pkg) return notInstalled("unreadable", null, null, `could not read ${debPath} with dpkg-deb`);
  if (pkg.name !== DEB_PACKAGE) {
    return notInstalled("not-our-package", pkg.version, null, `the download is package ${pkg.name}`);
  }

  // Missing helper: refuse rather than fall back to `pkexec /bin/bash -c`,
  // which is the anonymous prompt this file exists to replace.
  if (!exists(helper)) return notInstalled("no-helper", pkg.version, null, `${helper} is missing`);

  const attempt = isRoot
    ? run(helper, [debPath])
    : run(PKEXEC, ["--disable-internal-agent", helper, debPath]);

  // THE DECISION. Not the exit code: the installed version.
  const now = readInstalled(run);
  if (now && now.ok && now.version === pkg.version) return { installed: true, version: pkg.version };

  const found = now ? `${now.version}${now.ok ? "" : " (not fully installed)"}` : null;
  if (attempt.error?.code === "ENOENT") return notInstalled("no-pkexec", pkg.version, found, describe(attempt));
  if (!isRoot && attempt.status === 126) return notInstalled("declined", pkg.version, found, describe(attempt));
  if (!isRoot && attempt.status === 127) return notInstalled("not-authorised", pkg.version, found, describe(attempt));
  return notInstalled("failed", pkg.version, found, describe(attempt));
}

/** One sentence for the update row. The log carries the detail. */
export function notInstalledMessage(result: Extract<DebInstallResult, { installed: false }>): string {
  const what = result.expected ? `The update to v${result.expected} was not installed` : "The update was not installed";
  switch (result.reason) {
    case "declined":
      return `${what}: the password prompt was cancelled.`;
    case "not-authorised":
      return `${what}: permission to install it was not given.`;
    case "no-pkexec":
      return `${what}: this system has no pkexec to ask for permission with.`;
    case "no-helper":
      return `${what}: this installation is missing its update helper. Reinstalling Studio fixes it.`;
    default:
      return `${what}.`;
  }
}
