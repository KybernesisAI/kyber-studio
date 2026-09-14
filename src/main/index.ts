import { stopAll } from "./localMcp";
import { warmUp } from "./dictation";
import { registerUpdater } from "./updater";
import { join } from "node:path";
import { BrowserWindow, app, safeStorage, shell } from "electron";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { registerIpc } from "./ipc";
import { setLocalExecWindow, startLocalExec, stopLocalExec } from "./localExec";
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
/**
 * The main window, tracked so things that must reach the PERSON — updater
 * progress, for one — never address the orb by accident. getAllWindows()[0] is
 * not the main window: close the main window on macOS with the orb floating and
 * the orb becomes index 0, which silently sent the update UI nowhere.
 */
let mainWindow: BrowserWindow | null = null;

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
      // .cjs, and bundled — both halves, or the bridge does not attach.
      //
      // The renderer is sandboxed, which is Electron's default and what
      // `sandbox: false` used to opt out of here. A sandboxed preload is run as
      // plain script with no ESM context, so it cannot be the .mjs that
      // "type": "module" would otherwise emit; electron-vite builds it to
      // CommonJS for exactly that reason. Its `require` reaches `electron` and a
      // few polyfilled builtins and NOTHING from node_modules, which is why the
      // preload config bundles @electron-toolkit/preload in rather than
      // externalising it. CJS alone is not enough; CJS and inlined is.
      //
      // Both mistakes fail the same way, and the way is the problem: the bridge
      // never attaches, every window.studio call is undefined, and the app looks
      // SIGNED OUT rather than broken. Nothing reaches a log. Do not judge this
      // by the app starting.
      //
      // `sandbox: false` came across from KBDE, where nodeIntegrationInSubFrames
      // made it necessary. Studio has no such frames and its preload is pure IPC
      // — no Node APIs at all — so the flag bought nothing and cost both windows
      // their sandbox: Electron implements it by spawning the renderer
      // --no-sandbox --no-zygote, in the host user namespace, NoNewPrivs 0,
      // Seccomp 0. Do not reintroduce it to fix a preload problem.
      preload: join(__dirname, "../preload/index.cjs"),
    },
  });
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  // The renderer's console, in the same log as main's: a live-thread event that
  // reaches preload and dies in the store is invisible otherwise.
  win.webContents.on("console-message", (_e, _level, message) => {
    if (message.startsWith("[")) console.log(`[renderer] ${message}`);
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
  registerUpdater(() => mainWindow);
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
app.on("will-quit", () => {
  // Stop the local-execution poller alongside the MCP servers: it was written
  // for exactly this and never wired up, so it kept polling the relay through
  // teardown.
  stopLocalExec();
  stopAll();
});
