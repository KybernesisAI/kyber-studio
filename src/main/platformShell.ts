import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

/**
 * How to run a command line, and how to stop it, on the platform we are on.
 *
 * Both of this app's command-execution paths — the local-exec relay and local
 * MCP servers — used to hardcode `spawn(process.env.SHELL ?? "/bin/bash",
 * ["-lc", line])`. On Windows there is no `SHELL`, no `/bin/bash` and no `-lc`,
 * so both were dead on arrival rather than degraded.
 *
 * The POSIX form is unchanged by this module. Only Windows is new.
 */

export interface ShellInvocation {
  /** The program to spawn. */
  file: string;
  /** Its arguments, with the command line as the final element. */
  args: string[];
  /**
   * Windows only. Pass straight to `spawn`; on POSIX it is `undefined` and
   * `spawn` ignores it.
   */
  windowsVerbatimArguments?: boolean;
}

/**
 * Run `commandLine` through this platform's shell.
 *
 * ## Why a shell at all
 *
 * The relay receives a command LINE from an agent — `npm test && npm run lint`,
 * pipes, globs and all — not a program plus arguments. Something has to parse
 * it, and that is what a shell is for.
 *
 * ## Why a LOGIN shell on POSIX, and why Windows needs no equivalent
 *
 * `-l` sources the user's profile, so an agent told "run npm test" gets the npm
 * the user has rather than the minimal PATH an Electron app inherits. On
 * Windows there is no profile to source: PATH lives in the registry and is
 * inherited by every process, so the reason for `-l` does not transfer and
 * there is nothing to replace it with.
 *
 * Windows still needs the shell for a different reason — `npx` and friends are
 * `.cmd` shims, and node's own documentation states that `.bat` and `.cmd`
 * files cannot be spawned directly. It recommends spawning `cmd.exe` and
 * passing the command as an argument, which is what this does.
 *
 * ## Why not `shell: true`
 *
 * Because on POSIX it runs `/bin/sh`, NOT a login shell — which would throw
 * away the entire reason this module exists. Everything above about the user's
 * own PATH would stop being true.
 *
 * There is also DEP0190, a runtime deprecation as of node 24 covering
 * `shell: true` when an args array is passed too, because those args are
 * space-joined rather than escaped. That one does not strictly apply to us —
 * node only emits it when `args.length > 0` — so it is a reason to distrust the
 * option, not the reason this module does not use it.
 *
 * ## The two Windows switches
 *
 * - `/d` skips any `AutoRun` command the user has in the registry. Without it,
 *   every agent-issued command would first run whatever `AutoRun` holds, and
 *   its output would arrive interleaved with the command's own.
 * - `/s` makes `cmd.exe` strip the FIRST and LAST quote of the string after
 *   `/c` and otherwise leave it alone. That is why the command line is wrapped
 *   in a pair of quotes here: the pair `/s` eats has to be OURS. Without the
 *   wrap it eats the caller's, so `"C:\\Program Files\\nodejs\\npm.cmd" test`
 *   becomes an attempt to run `C:\\Program` — and a path under
 *   `C:\\Program Files` is the ordinary Windows shape, not an edge case.
 *   `windowsVerbatimArguments` then stops node adding quoting of its own on
 *   top. This is the form node itself uses internally for `shell: true`.
 *
 * What is TESTED: the file and argv this returns on both platforms, that the
 * command line is always the last element, and that `ComSpec` and `SHELL` are
 * honoured when set. Whether `cmd.exe` then behaves as documented is not
 * tested here — it cannot be, off Windows.
 */
export function shellInvocation(commandLine: string): ShellInvocation {
  // Read at call time, not at module load: a test can pin `process.platform`
  // around a single call, and the main process never changes platform anyway.
  if (process.platform === "win32") {
    return {
      // Microsoft requires %COMSPEC% in the root environment but not in a
      // child's, so node falls back to the bare name; so do we.
      file: process.env.ComSpec ?? "cmd.exe",
      // The wrap is load-bearing, not decoration — see the docblock. Review
      // found this missing: the comment above described the mechanism
      // correctly while the code supplied no pair for `/s` to strip.
      args: ["/d", "/s", "/c", `"${commandLine}"`],
      windowsVerbatimArguments: true,
    };
  }
  return {
    file: process.env.SHELL ?? "/bin/bash",
    args: ["-lc", commandLine],
  };
}

/**
 * Stop a shell-spawned child and anything it started.
 *
 * ## The name is only fully true on Windows. Read this before trusting it.
 *
 * **On Windows** `cmd.exe /c` never execs: it creates a separate child and
 * waits. Terminating the pid we hold would stop `cmd.exe` and leave the actual
 * command — a build, a test run, a dev server — running with no parent and no
 * handle. `taskkill /T` walks the tree and `/F` does not ask, so here the whole
 * tree really does go.
 *
 * **On POSIX only the direct child is signalled, and a compound command can
 * still orphan.** `bash -lc 'sleep 5'` execs, so the pid we hold IS `sleep`.
 * `bash -lc 'sleep 5 && echo done'` does not: bash stays, forks, and killing
 * the pid we hold leaves `sleep` reparented to init. Compound lines are exactly
 * what the relay is for, so this is a real hole — but it is PRE-EXISTING and
 * unchanged by this module, which is why it is documented rather than fixed
 * here. Closing it needs a process group (`detached` at the spawn plus
 * `process.kill(-pid)`), which is a live behaviour change on the platform that
 * has users, and belongs in its own ticket.
 *
 * Measured, not assumed: `bash -lc 'sleep 5 && echo done'` then `kill -9` on
 * the shell's pid leaves `sleep` running with ppid 1.
 *
 * ## The signal, and why it is a parameter
 *
 * Callers had different ones and both are preserved. `stopAll` used a bare
 * `child.kill()`, which is SIGTERM — an MCP server's one chance to flush state
 * or drop a lockfile — so SIGTERM is the default. The relay's timeout used
 * SIGKILL and passes it explicitly.
 *
 * On Windows the distinction does not exist: `taskkill /F` is forceful either
 * way, because there is no graceful signal to send. Stated rather than hidden.
 *
 * REASONED, not measured: that `cmd.exe /c` orphans its child. It follows from
 * documented behaviour, not from an observation on Windows. The observation
 * that would confirm it is a timed-out `run-command` on Windows leaving no
 * stray process in Task Manager.
 *
 * What is TESTED: the signal each caller gets on POSIX, that Windows shells out
 * to `taskkill` with the tree and force flags and the child's own pid, and both
 * fallbacks when `taskkill` cannot run.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (process.platform === "win32") {
    if (typeof child.pid === "number") {
      try {
        // Absolute path rather than the bare name: this is the process-control
        // path of a component that runs agent-supplied commands, so it should
        // not be resolvable through PATH.
        const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
        // Detached and fully ignored: we are not waiting on the killer, and its
        // output would otherwise be attributed to the command being killed.
        const killer = spawn(taskkill, ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          detached: true,
        });
        killer.unref();
        // A failed `taskkill` must not surface as an unhandled error event on a
        // process we are already abandoning.
        killer.on("error", () => child.kill());
        return;
      } catch {
        // Fall through to the handle we hold.
      }
    }
    // No signal name: once we are down to the handle on Windows this is a
    // TerminateProcess either way, and `signal` has nothing left to express.
    child.kill();
    return;
  }
  child.kill(signal);
}
