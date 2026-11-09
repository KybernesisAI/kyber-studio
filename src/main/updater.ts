import { app, ipcMain, type BrowserWindow } from "electron";
// Default import, then destructure: electron-updater is CommonJS and this
// bundle is ESM ("type": "module"), so a named import compiles to a live
// binding the package cannot provide. It works in dev — where the module is
// bundled — and throws on launch once packaged, where it stays external. Eve
// Studio does not hit this only because its main process is CommonJS.
import electronUpdater from "electron-updater";
import { existsSync } from "node:fs";
import { installDebUpdate, notInstalledMessage, systemRun } from "./debInstall";

const { autoUpdater, DebUpdater } = electronUpdater;

/**
 * In-app updates, the same shape Eve Studio uses.
 *
 * A desktop app that people have to re-download by hand is a desktop app that
 * stays on the version it was installed at, which matters more here than usual:
 * every fix in this app so far has been to a failure the user experienced
 * directly, and they should not have to hear about a release to get it.
 *
 * Downloads are not automatic. Pulling a hundred megabytes down someone's
 * tether without asking is rude, and an update that installs itself mid-turn is
 * worse — it takes the conversation with it. The renderer offers it; the person
 * decides when.
 */

import type { UpdateState } from "@shared/ipc";

const state: UpdateState = { status: "idle", version: null };
let getWindow: (() => BrowserWindow | null) | null = null;

function push(next: Partial<UpdateState>): void {
  Object.assign(state, next);
  const win = getWindow?.();
  if (win && !win.isDestroyed()) win.webContents.send("studio:updater", state);
}

export function registerUpdater(window: () => BrowserWindow | null): void {
  getWindow = window;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  replaceDebInstall();

  ipcMain.handle("studio:updaterState", () => state);

  ipcMain.handle("studio:updaterCheck", async () => {
    // An unpackaged build has no release to compare against, and saying so is
    // better than a confusing "up to date" during development.
    if (!app.isPackaged) return { ok: false, error: "Updates only run in packaged builds." };
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  });

  ipcMain.handle("studio:updaterDownload", async () => {
    if (state.status !== "available") return { ok: false, error: "No update available." };
    try {
      push({ status: "downloading", percent: 0 });
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (error) {
      push({ status: "error", error: String(error) });
      return { ok: false, error: String(error) };
    }
  });

  ipcMain.handle("studio:updaterInstall", () => {
    // Show progress, and relaunch afterwards: a silent quit reads as a crash.
    autoUpdater.quitAndInstall(false, true);
  });

  autoUpdater.on("checking-for-update", () => push({ status: "checking" }));
  autoUpdater.on("update-available", (info) => push({ status: "available", version: info.version }));
  autoUpdater.on("update-not-available", () =>
    push({ status: "idle", version: null, percent: undefined }),
  );
  autoUpdater.on("download-progress", (p) =>
    push({ status: "downloading", percent: Math.round(p.percent) }),
  );
  autoUpdater.on("update-downloaded", (info) =>
    push({ status: "downloaded", version: info.version }),
  );
  autoUpdater.on("error", (error) => {
    // Being offline, or a repo with no releases yet, is routine and must not
    // become a banner. Logged, not surfaced.
    console.warn("[updater]", error.message);
    push({ status: "idle", error: error.message });
  });

  if (app.isPackaged) {
    // Not at launch: the first seconds belong to the window opening.
    setTimeout(() => void autoUpdater.checkForUpdates().catch(() => undefined), 8_000);
    setInterval(
      () => void autoUpdater.checkForUpdates().catch(() => undefined),
      6 * 60 * 60 * 1000,
    );
  }
}

/**
 * The pieces of electron-updater 6.8.9's `DebUpdater` that the replacement
 * install step reaches. All are `protected` in its typings, which is why this
 * is a structural cast rather than a subclass: `autoUpdater` is constructed by
 * electron-updater itself, which also decides (from `resources/package-type`)
 * that this is a `.deb` install. Re-implementing that detection to construct a
 * subclass would be a second copy of it that could drift.
 */
interface DebInternals {
  doInstall(options: { isSilent: boolean; isForceRunAfter: boolean }): boolean;
  downloadedUpdateHelper: { file: string | null } | null;
  autoInstallOnAppQuit: boolean;
  app: { relaunch(): void };
  _logger: { info(message: string): void; warn(message: string): void; error(message: string): void };
}

/**
 * KYB-670: on a `.deb` install, replace electron-updater's install step with
 * `installDebUpdate` (see `debInstall.ts` for why). Does nothing for the
 * AppImage, macOS or Windows, whose updaters are not `DebUpdater`.
 *
 * Two behaviours belong here rather than in `debInstall.ts`, because they are
 * about the updater's state, not about installing:
 *
 * - **Not installed means not installed.** Returning `false` makes
 *   `quitAndInstall` stay open instead of quitting, and the row says the update
 *   was not installed. No `error` event is dispatched: the `error` handler below
 *   turns every error into `idle`, which hides the row (KYB-606), and that
 *   would overwrite the message.
 * - **A failed install stops install-on-quit for the rest of the session.**
 *   electron-updater re-arms it after a failed install (`BaseUpdater.js:25`), so
 *   quitting after a cancel asked again, twice, with no window on screen. The
 *   quit handler checks `autoInstallOnAppQuit` at quit time, so clearing it is
 *   enough. The row's **Retry** checks again, and the next **Restart to
 *   update** installs as normal. *Reasoned, not tried:* the download is reused,
 *   because electron-updater keeps a verified download in its cache.
 */
function replaceDebInstall(): void {
  if (!(autoUpdater instanceof DebUpdater)) return;
  const updater = autoUpdater as unknown as DebInternals;

  updater.doInstall = (options) => {
    const debPath = updater.downloadedUpdateHelper?.file ?? null;
    if (!debPath) {
      updater._logger.error("[updater] no downloaded .deb to install");
      push({ status: "error", error: "The update was not installed: the download is missing." });
      return false;
    }
    updater._logger.info(`[updater] installing ${debPath}`);
    const result = installDebUpdate({
      debPath,
      isRoot: process.getuid?.() === 0,
      run: systemRun,
      exists: existsSync,
    });

    if (result.installed) {
      updater._logger.info(`[updater] installed ${result.version}`);
      if (options.isForceRunAfter) updater.app.relaunch();
      return true;
    }

    updater._logger.warn(
      `[updater] not installed (${result.reason}): expected ${result.expected ?? "?"}, ` +
        `dpkg reports ${result.found ?? "nothing"}; ${result.detail}`,
    );
    updater.autoInstallOnAppQuit = false;
    push({ status: "error", error: notInstalledMessage(result) });
    return false;
  };
}
