import { stopAll } from "./localMcp";
import { warmUp } from "./dictation";
import { registerUpdater } from "./updater";
import { join } from "node:path";
import { BrowserWindow, app, safeStorage, shell } from "electron";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { registerIpc } from "./ipc";
import { setLocalExecWindow, startLocalExec } from "./localExec";
import { createCredentialStorageReporter } from "./credentialStorage";

/**
 * Say which credential store the OS gave us — once, and only once there is a
 * window to say it behind.
 *
 * On Linux `isEncryptionAvailable()` answers true even when the backend is
 * `basic_text`, a hard-coded key shared by every install, so the promise in
 * controlPlane.ts can be broken on a machine that looks fine from inside the
 * app. Asking the second question is how we find out which machines those are.
 */
const reportCredentialStorage = createCredentialStorageReporter(safeStorage);

/**
 * The window is deliberately chrome-light: a hidden-inset title bar with traffic
 * lights over the sidebar, matching the reference app. Studio is a chat client,
 * so the window furniture should disappear behind the conversation.
 */
function createWindow(): void {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 720,
    minHeight: 520,
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: "#ffffff",
    webPreferences: {
      // .mjs, not .js: this package is "type": "module", so electron-vite
      // emits an ESM preload. Pointing at .js loads nothing, the context bridge
      // never attaches, and the renderer sees no window.studio at all — which
      // looks like a logged-out app rather than a broken preload path.
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
    },
  });

  win.on("ready-to-show", () => {
    win.show();
    // Deferred to here on purpose: asking about the credential store is what
    // makes the OS unlock its keyring, and on Linux that can raise a system
    // password dialog and block the main process until it is answered. Run
    // from whenReady it did exactly that — a password prompt with no
    // application behind it, and no window until the user dealt with it.
    //
    // The reporter defers again internally so it does not block inside this
    // handler. It does not make the window paint first — measured on MATE, it
    // is still blank behind the prompt — and that is accepted.
    reportCredentialStorage();
  });
  // The permission card lives in this window, so local execution must know
  // which contents to ask in — and must refuse rather than assume consent when
  // there is no window.
  setLocalExecWindow(win.webContents);
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

void app.whenReady().then(() => {
  electronApp.setAppUserModelId("ai.kybernesis.kyberstudio");
  registerIpc();
  // The updater needs a live window to report progress to, and windows come and
  // go on macOS — so it takes a getter rather than an instance.
  registerUpdater(() => BrowserWindow.getAllWindows()[0] ?? null);
  startLocalExec();
  app.on("browser-window-created", (_, window) => optimizer.watchWindowShortcuts(window));
  createWindow();
  // Load the speech model in the background so the first dictation is not the
  // one that waits for it. Silent on failure: nobody asked for anything yet.
  warmUp();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// A local MCP server holds real resources — a database connection, a file
// watcher, a port. None of them should outlive the app that started them, and
// an orphaned server is the kind of thing a user finds in Activity Monitor a
// week later and never trusts again.
app.on("will-quit", () => stopAll());
