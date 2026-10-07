import { spawn, type ChildProcess } from "node:child_process";

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
 * It is runtime-deprecated as of node 24 (DEP0190) when an args array is also
 * passed, because the args are space-joined rather than escaped. We are on node
 * >= 24.15.0, so that route is closed on purpose rather than by preference.
 *
 * ## The two Windows switches
 *
 * - `/d` skips any `AutoRun` command the user has in the registry. Without it,
 *   every agent-issued command would first run whatever `AutoRun` holds, and
 *   its output would arrive interleaved with the command's own.
 * - `/s`, paired with `windowsVerbatimArguments`, is the combination node
 *   documents under "Shell requirements". `/s` makes `cmd.exe` strip one outer
 *   pair of quotes and otherwise leave the string alone, and the verbatim flag
 *   stops node quoting it a second time on the way in. Either one without the
 *   other mangles a command containing quotes.
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
      args: ["/d", "/s", "/c", commandLine],
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
 * ## Why this is not just `child.kill()`
 *
 * On POSIX, `bash -c <single command>` normally execs the command, replacing
 * the shell, so the pid we hold IS the command and a signal reaches it.
 *
 * `cmd.exe /c` never execs: it always creates a separate child and waits. So
 * terminating the pid we hold stops `cmd.exe` and leaves the actual command —
 * a build, a test run, a dev server — running with no parent and no handle.
 * Every timeout would leak a process onto the user's machine.
 *
 * `taskkill /T` walks the tree and `/F` does not ask. If it cannot be spawned
 * at all we still terminate the handle we have, which is strictly better than
 * nothing.
 *
 * REASONED, not measured: the claim that `cmd.exe /c` orphans its child is from
 * its documented behaviour, not from an observation on Windows. The observation
 * that would confirm it is a timed-out `run-command` on Windows leaving no
 * stray process in Task Manager.
 *
 * What is TESTED: that POSIX signals the child directly, that Windows shells
 * out to `taskkill` with the tree and force flags and the child's own pid, and
 * that a child with no pid falls back to signalling the handle.
 */
export function killTree(child: ChildProcess): void {
  if (process.platform === "win32" && typeof child.pid === "number") {
    try {
      // Detached and fully ignored: we are not waiting on the killer, and its
      // output would otherwise be attributed to the command being killed.
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
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
  child.kill(process.platform === "win32" ? undefined : "SIGKILL");
}
