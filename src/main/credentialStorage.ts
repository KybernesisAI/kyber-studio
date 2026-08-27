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
 * Two things are deliberate here, and both were learned the hard way on a
 * Linux Mint MATE box with a locked keyring.
 *
 * **It reports at most once.** `createWindow` runs again on macOS `activate`,
 * and a diagnostic that reprints every time a window opens stops reading as a
 * fact about the machine and starts reading as noise.
 *
 * **It must not be called before there is a window on screen.** Asking these
 * questions is what triggers the OS to unlock its keyring, and on Linux that
 * can put a system password dialog in front of the user and block the main
 * process until it is answered. Called too early, the first thing a new user
 * sees is an unexplained password prompt with no application behind it, and
 * the window does not appear until they deal with it. Observed, not theorised.
 * The call site belongs after `ready-to-show`.
 */
export function createCredentialStorageReporter(
  safeStorage: SafeStorageLike,
  log: (line: string) => void = console.log,
): () => void {
  let reported = false;
  return () => {
    if (reported) return;
    reported = true;
    log(describeCredentialStorage(collectCredentialStorage(safeStorage)));
  };
}
