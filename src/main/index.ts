import { stopAll } from "./localMcp";
import { join } from "node:path";
import { BrowserWindow, app, shell } from "electron";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { registerIpc } from "./ipc";
import { setLocalExecWindow, startLocalExec } from "./localExec";

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

  win.on("ready-to-show", () => win.show());
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
  startLocalExec();
  app.on("browser-window-created", (_, window) => optimizer.watchWindowShortcuts(window));
  createWindow();
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
