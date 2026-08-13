import { app, ipcMain, type BrowserWindow } from "electron";
// Default import, then destructure: electron-updater is CommonJS and this
// bundle is ESM ("type": "module"), so a named import compiles to a live
// binding the package cannot provide. It works in dev — where the module is
// bundled — and throws on launch once packaged, where it stays external. Eve
// Studio does not hit this only because its main process is CommonJS.
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

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

export interface UpdateState {
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "error";
  version: string | null;
  percent?: number;
  error?: string;
}

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
