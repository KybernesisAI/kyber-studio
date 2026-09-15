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
 * Put every renderer this app will ever create in the Chromium sandbox, once,
 * here — rather than trusting each window's webPreferences not to opt out.
 *
 * This is the same guarantee the per-window comment in createWindow() describes,
 * made structural. KYB-569 was `webPreferences.sandbox: false`, and the guard
 * written against it had to ENUMERATE the spellings that turn the sandbox off.
 * Two review rounds each found that list incomplete — `nodeIntegration: true`,
 * then `nodeIntegrationInWorker: true`. A list that has to stay exhaustive to be
 * correct is a poor guarantee, because the failure of it is silent. One call
 * that outranks all of them is a better one.
 *
 * How it outranks them, in Electron 34.5.8, written down because it is not where
 * you would look. enableSandbox() strips any --no-sandbox already on the command
 * line and appends `enable-sandbox`
 * (shell/browser/api/electron_api_app.cc:1429-1440; the switch itself is
 * shell/common/options_switches.cc:199). That switch is then copied onto every
 * renderer's command line (shell/browser/electron_browser_client.cc:533-540)
 * BEFORE the per-window preferences get their say at :573. And their say is
 * this, from shell/browser/web_contents_preferences.cc:320-325:
 *
 *     if (IsSandboxed() || can_sandbox_frame) {
 *       command_line->AppendSwitch(switches::kEnableSandbox);
 *     } else if (!command_line->HasSwitch(switches::kEnableSandbox)) {
 *       command_line->AppendSwitch(sandbox::policy::switches::kNoSandbox);
 *       command_line->AppendSwitch(::switches::kNoZygote);
 *     }
 *
 * `sandbox: false`, `nodeIntegration: true` and `nodeIntegrationInWorker: true`
 * all work by making IsSandboxed() return false (:280-286). With the switch
 * present the else branch cannot fire, so not one of them can reach
 * --no-sandbox --no-zygote any more. That is the point of doing it here: three
 * spellings defeated by one positive act instead of three negative ones.
 *
 * Note carefully that it is the else-IF that does this, and NOT IsSandboxed()
 * itself — IsSandboxed() reads the webPreferences value first and never consults
 * the switch at all. Anyone re-checking this against a later Electron should
 * look at :320-325, not at :280-286, or they will conclude it does not work.
 *
 * It is FOUR spellings, not three. `nodeIntegrationInSubFrames: true` is covered
 * too, and the previous revision of this file was wrong to imply otherwise — the
 * correction is set out at the webPreferences block below. In short: that flag
 * feeds `can_sandbox_frame` at :318, which appears only in the POSITIVE arm at
 * :320. It can withhold an AppendSwitch; it can never cause one to be removed,
 * and there is no path from it to kNoSandbox. The only path to kNoSandbox is the
 * else-if, and this call blocks it for subframe renderers exactly as it does for
 * main ones.
 *
 * WHAT THIS CALL DOES NOT CLOSE, which matters more than what it does, because
 * this is the file somebody would add it to. The guarantee is a switch on a
 * mutable command line, so anything that can edit that command line AFTERWARDS
 * outranks it in turn:
 *
 *     app.commandLine.removeSwitch("enable-sandbox")
 *
 * takes `enable-sandbox` straight back out of switches_
 * (shell/common/api/electron_api_command_line.cc:62 → Chromium
 * base/command_line.cc:446), and HasSwitch at :322 reads switches_ and nothing
 * else (base/command_line.cc:340-343). One such line anywhere in src/main puts
 * the app back in the KYB-569 state, silently. It does not override this call;
 * it deletes it. test/renderer-sandbox.test.mjs enumerates that route and
 * `appendSwitch("no-sandbox")` beside it, and for those two the enumeration is
 * still the whole guarantee — review round 4 found the list missing removeSwitch
 * and the comment above it claiming, wrongly, that an incomplete list could no
 * longer be a hole. Do not add such a call here to fix a preload problem, and do
 * not delete the entries that catch it.
 *
 * It must run before the app is ready: EnableSandbox throws outright if
 * Browser::Get()->is_ready() (:1430-1435). Hence module scope, not whenReady().
 *
 * What this does not change is the reason any of it is guarded rather than
 * merely written down: the failure is SILENT. The bridge never attaches,
 * window.studio is undefined, and the app looks SIGNED OUT rather than broken.
 * Do not judge this by the app starting.
 */
app.enableSandbox();

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
      // their sandbox: Electron implemented it by spawning the renderer
      // --no-sandbox --no-zygote, in the host user namespace, NoNewPrivs 0,
      // Seccomp 0. Do not reintroduce it to fix a preload problem.
      //
      // That last route is now closed at the app level — app.enableSandbox() at
      // the top of this file means `sandbox: false` here can no longer reach
      // --no-sandbox, which is why this comment says "implemented" and not
      // "implements". The flag would now be merely wrong rather than dangerous.
      // It is still wrong: it tells the renderer it is unsandboxed while the
      // process it runs in is sandboxed anyway, and the preload breaks on the
      // difference. The app-wide call is the guarantee; this is still the place
      // a person edits, so it is still written down here.
      //
      // And do not reach for nodeIntegrationInSubFrames itself either, though
      // the reason is NOT the one this branch gave until review round 4. It was
      // written here and in the test that the flag "unsandboxes cross-origin
      // subframes", and that app.enableSandbox() did not speak to it. Both
      // halves are wrong against 34.5.8. web_contents_preferences.cc:318 sets
      // `can_sandbox_frame = is_subframe && !node_integration_in_sub_frames_`,
      // and can_sandbox_frame is read at :320 — the positive arm, the one that
      // APPENDS kEnableSandbox. Turning the flag on withholds that extra append.
      // It cannot append kNoSandbox, because the only statement that does sits
      // in the else-if at :322, behind the switch enableSandbox() has already
      // set. So the app-wide call covers the subframe case too.
      //
      // The real cost of the flag is a different one, and enableSandbox() does
      // not touch it: nodeIntegrationInSubFrames: true runs the preload in EVERY
      // subframe. Every one, not merely the cross-origin ones — ShouldLoadPreload
      // returns `(is_main_frame || is_devtools || allow_node_in_sub_frames) &&
      // !IsWebViewFrame(...)` and never looks at an origin
      // (shell/renderer/renderer_client_base.cc:216-227). The SANDBOXED renderer
      // client asks the same question (electron_sandboxed_renderer_client.cc
      // :167-174), so forcing the sandbox on does not take the preload back out
      // of those frames. It hands the whole window.studio contextBridge surface
      // — the control-plane IPC included — to whatever each frame is showing. A
      // sandboxed frame with the bridge in it is still a frame with the bridge
      // in it. That is why the test still refuses the flag, and why it refuses
      // it as an exposure rather than as a sandbox switch.
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
