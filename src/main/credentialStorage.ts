/**
 * Report which credential store the OS actually gave us.
 *
 * @remarks
 * `safeStorage.isEncryptionAvailable()` is the only question the app has ever
 * asked, and on Linux it is not a sufficient one. It returns `true` even when
 * Chromium fell back to the `basic_text` backend, which "encrypts" with a
 * hard-coded public key — so a machine with no usable keyring answers exactly
 * like a machine with a real one. `controlPlane.ts` promises never to fall
 * back to plaintext silently, and on that machine the promise is broken
 * silently, which is the worst of both.
 *
 * `getSelectedStorageBackend()` is the second question. Asking both and
 * printing the answers side by side is the entire contribution of this file:
 * the disagreement between them is the defect, and until now nothing in the
 * running app could see it.
 *
 * **This measures, it does not decide.** Nothing here changes what is stored,
 * where, or under what conditions. What to *do* about a weak backend — refuse
 * to persist, force a different store, keep secrets by reference — is a
 * policy question, and it is deliberately somewhere else.
 *
 * No Electron import: the `safeStorage` object is passed in. That keeps the
 * logic loadable by `node --test`, which is the difference between this being
 * tested and being hoped at.
 */

/** The parts of Electron's `safeStorage` this file needs, and nothing more. */
export type SafeStorageLike = {
  isEncryptionAvailable: () => boolean;
  getSelectedStorageBackend: () => string;
};

/**
 * Ask the OS whether it can encrypt — at most once for the life of the process.
 *
 * @remarks
 * Availability is **latched by the OS**, not merely expensive to ask about.
 * Measured on Linux Mint, Electron 34.5.8: a run that begins with the keyring
 * locked stays broken after the keyring is unlocked mid-run, and a run that
 * begins unlocked keeps working after it is locked again. So a second ask can
 * only ever repeat the first answer — at the price of a second unlock dialog,
 * because asking is the thing that raises one.
 *
 * It lives here, beside `SafeStorageLike`, rather than in either caller. The
 * session layer (`controlPlane.ts`) and the MCP layer (`localMcp.ts`) need the
 * same single answer, and a cache held by either is a cache the other misses:
 * `localMcp.ts` had one and `controlPlane.ts` asked raw, twice, so a signed-in
 * user with an MCP server could be prompted more than once. Having the session
 * layer import the MCP layer would have fixed the count and inverted the
 * dependency; this file already owns the abstraction and depends on nothing.
 *
 * `safeStorage` is injected for the same reason as everywhere else in this
 * file: no Electron import, so `node --test` can load it.
 *
 * There is deliberately no reset hook. The answer is process-wide by design,
 * and this suite's convention for wanting a different one is a different
 * process — one test file per answer, which is why
 * `local-mcp-call-sites.test.mjs` (available) and
 * `local-mcp-locked-store.test.mjs` (locked) are two files and not two tests.
 */
let availabilityAnswer: boolean | null = null;

export function isCredentialStoreAvailable(
  safeStorage: Pick<SafeStorageLike, "isEncryptionAvailable">,
): boolean {
  if (availabilityAnswer === null) availabilityAnswer = safeStorage.isEncryptionAvailable();
  return availabilityAnswer;
}

export type CredentialStorageReport = {
  platform: string;
  encryptionAvailable: boolean;
  /** Linux only. `null` off Linux, and `null` if the call failed. */
  backend: string | null;
  /** The value of an explicit `--password-store` switch, if one was given. */
  override: string | null;
  /** Encryption claims to be available, but the backend cannot deliver it. */
  weak: boolean;
};

/**
 * Backends that report success while providing no real protection.
 *
 * `basic_text` is Chromium's last resort: a hard-coded key compiled into the
 * binary, identical on every machine on earth. Anything sealed with it is
 * readable by anyone holding the file.
 */
const WEAK_BACKENDS = new Set(["basic_text"]);

/**
 * Read an explicit `--password-store` from the command line.
 *
 * Recorded because it overrides Chromium's detection entirely. Without it the
 * measurements are ambiguous — a machine forced onto libsecret looks exactly
 * like one that chose libsecret on its own, and those are different facts.
 *
 * Both spellings are accepted because Chromium accepts both.
 */
export function readPasswordStoreOverride(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg.startsWith("--password-store=")) {
      const value = arg.slice("--password-store=".length);
      return value.length > 0 ? value : null;
    }
    if (arg === "--password-store") return argv[i + 1] ?? null;
  }
  return null;
}

/**
 * Ask both questions and record the answers.
 *
 * Two things are load-bearing here:
 *
 * `getSelectedStorageBackend()` is a **Linux-only** API. Calling it elsewhere
 * is how a diagnostic added for Linux becomes a crash on the platform that was
 * already working, so it is guarded by platform rather than by try/catch alone.
 *
 * It is also wrapped, because a diagnostic that can take the app down is worse
 * than no diagnostic at all. A backend we could not determine is reported as
 * unknown; it is never allowed to propagate.
 */
export function collectCredentialStorage(
  safeStorage: SafeStorageLike,
  env: { platform: string; argv: readonly string[] } = {
    platform: process.platform,
    argv: process.argv,
  },
): CredentialStorageReport {
  const encryptionAvailable = safeStorage.isEncryptionAvailable();

  let backend: string | null = null;
  if (env.platform === "linux") {
    try {
      backend = safeStorage.getSelectedStorageBackend();
    } catch {
      backend = null;
    }
  }

  return {
    platform: env.platform,
    encryptionAvailable,
    backend,
    override: readPasswordStoreOverride(env.argv),
    weak: encryptionAvailable && backend !== null && WEAK_BACKENDS.has(backend),
  };
}

/**
 * One line, because it is read off a terminal on six machines and pasted into
 * a ticket. Two lines is two things to copy and one thing to lose.
 */
export function describeCredentialStorage(report: CredentialStorageReport): string {
  const backend =
    report.platform === "linux" ? (report.backend ?? "unknown") : "n/a (Linux-only API)";

  const fields = [
    `platform=${report.platform}`,
    `backend=${backend}`,
    `encryptionAvailable=${report.encryptionAvailable}`,
    `passwordStore=${report.override ?? "auto"}`,
  ].join(" ");

  if (!report.weak) return `[storage] ${fields}`;

  return (
    `[storage] ${fields} — WARNING: encryption reports as available, but ${report.backend} ` +
    `uses a hard-coded key shared by every install. Anything "encrypted" here is readable ` +
    `by anyone holding the file.`
  );
}

/**
 * Build the reporter the main process calls.
 *
 * @remarks
 * Three things are deliberate here, and all three were learned on a Linux Mint
 * MATE box with a locked keyring.
 *
 * **It reports at most once.** `createWindow` runs again on macOS `activate`,
 * and a diagnostic that reprints every time a window opens stops reading as a
 * fact about the machine and starts reading as noise.
 *
 * **Construction asks nothing.** Only the call reaches the OS, so building the
 * reporter at module scope cannot trigger a keyring unlock before the app has
 * decided it is ready to survive one.
 *
 * **The questions are asked on a later tick than the call.** Asking is what
 * makes the OS unlock its keyring, and on Linux that can raise a system
 * password dialog and block the main process until it is answered — so the
 * call must not block inside the `ready-to-show` handler that made it, where
 * everything else queued on the main process would wait behind a dialog the
 * user may take a minute to answer. The scheduler is injectable so that is a
 * tested property rather than an assumption.
 *
 * What deferring does **not** buy is a painted window. That was the original
 * argument for it and it was wrong: measured on Linux Mint MATE with a locked
 * keyring, the window is still blank behind the prompt, because `show()` only
 * starts the presentation and that VM is on Chromium's software rasteriser, so
 * first paint takes far longer than a turn of the loop. Getting a painted frame
 * would need the renderer to signal back after its first paint — an IPC
 * round-trip for a diagnostic, to turn a blank rectangle into a white one.
 * Judged not worth it; the blank window behind an unlock prompt is accepted.
 * The case that mattered — a prompt with *no* window behind it, from
 * `whenReady` — is fixed by the call site, not by this deferral.
 */
export function createCredentialStorageReporter(
  safeStorage: SafeStorageLike,
  log: (line: string) => void = console.log,
  schedule: (task: () => void) => void = setImmediate,
): () => void {
  let reported = false;
  return () => {
    // Latched before scheduling rather than inside the task: two calls in the
    // same tick must not queue two questions at the OS.
    if (reported) return;
    reported = true;
    schedule(() => {
      log(describeStorageDiagnostic(collectStorageDiagnostic(safeStorage)));
    });
  };
}

/**
 * The half of the report that can be gathered without opening the keyring.
 *
 * @remarks
 * Measured on Linux Mint, Electron 34.5.8, keyring locked: six calls to
 * `getSelectedStorageBackend()` over thirty seconds raised **no** dialog and
 * returned `gnome_libsecret` every time, while the first call to
 * `isEncryptionAvailable()` raised the unlock prompt immediately. The two
 * questions have different costs, and until KYB-590 they were asked together.
 *
 * That mattered once detection became lazy. The diagnostic is worth printing at
 * launch — knowing a machine chose `gnome_libsecret` rather than `kwallet6` is
 * the first thing anyone asks in support — but the availability question now
 * belongs at first credential use, where a prompt is something the user just
 * asked for. Splitting them keeps the line and drops its cost.
 *
 * It also means a user who never signs in and configures no MCP server is never
 * asked to unlock anything, which is the behaviour KYB-504's decision (a)
 * accepted the loss of and this reverses.
 */
export type StorageDiagnostic = {
  platform: string;
  /** Linux only. `null` off Linux, and `null` if the call failed. */
  backend: string | null;
  override: string | null;
};

export function collectStorageDiagnostic(
  safeStorage: Pick<SafeStorageLike, "getSelectedStorageBackend">,
  env: { platform: string; argv: readonly string[] } = process,
): StorageDiagnostic {
  let backend: string | null = null;
  if (env.platform === "linux") {
    try {
      backend = safeStorage.getSelectedStorageBackend();
    } catch {
      backend = null;
    }
  }
  return { platform: env.platform, backend, override: readPasswordStoreOverride(env.argv) };
}

/**
 * The startup line. Says plainly that availability was not asked, so nobody
 * reads its absence as a `false`.
 */
export function describeStorageDiagnostic(report: StorageDiagnostic): string {
  const backend =
    report.platform === "linux" ? (report.backend ?? "unknown") : "n/a (Linux-only API)";
  return (
    `[storage] platform=${report.platform} backend=${backend} ` +
    `passwordStore=${report.override ?? "auto"} encryptionAvailable=deferred`
  );
}
