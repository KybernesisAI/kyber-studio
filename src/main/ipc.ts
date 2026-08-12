import { ipcMain, type WebContents } from "electron";
import { loadState, pickFolder, saveState } from "./store";
import {
  type LocalAction,
  type LocalPermission,
  answerAsk,
  readPermissions,
  setPermission,
} from "./localExec";
import {
  type DeviceStart,
  agentInfo,
  manageCall,
  currentSession,
  listAgents,
  pollDeviceAuth,
  sendTurn,
  signOut,
  startDeviceAuth,
} from "./controlPlane";

/**
 * The device flow spans two calls — start (show the code) and await (poll) — so
 * the UI can display the user code while the browser round-trip happens. The
 * pending start is held here rather than round-tripped through the renderer, so
 * a device code never sits in web content.
 */
let pending: DeviceStart | null = null;

export function registerIpc(): void {
  ipcMain.handle("studio:session", () => currentSession());

  ipcMain.handle("studio:signIn", async () => {
    pending = await startDeviceAuth();
    return { userCode: pending.userCode, verificationUri: pending.verificationUri };
  });

  ipcMain.handle("studio:awaitSignIn", async () => {
    if (!pending) throw new Error("No sign-in in progress.");
    try {
      return await pollDeviceAuth(pending);
    } finally {
      pending = null;
    }
  });

  ipcMain.handle("studio:signOut", () => {
    pending = null;
    signOut();
  });

  ipcMain.handle("studio:listAgents", () => listAgents());

  ipcMain.handle("studio:agentInfo", (_e, url: string) => agentInfo(url));

  ipcMain.handle(
    "studio:localAnswer",
    (_e, input: { id: string; allow: boolean; remember: boolean }) => {
      answerAsk(input.id, input.allow, input.remember);
    },
  );
  ipcMain.handle("studio:localPermissions", () => readPermissions());

  ipcMain.handle("studio:loadState", (_e, name: string) => loadState(name, null));
  ipcMain.handle("studio:saveState", (_e, input: { name: string; value: unknown }) => {
    saveState(input.name, input.value);
  });
  ipcMain.handle("studio:pickFolder", () => pickFolder());

  ipcMain.handle(
    "studio:manage",
    (_e, input: { url: string; secret: string; path: string; body?: unknown }) => manageCall(input),
  );
  ipcMain.handle(
    "studio:setLocalPermission",
    (_e, input: { action: LocalAction; value: LocalPermission }) => {
      setPermission(input.action, input.value);
      return readPermissions();
    },
  );

  ipcMain.handle(
    "studio:send",
    (
      e,
      input: {
        url: string;
        text: string;
        sessionId?: string;
        continuationToken?: string;
        streamIndex?: number;
        clientContext?: Record<string, unknown>;
        streamId: string;
      },
    ) => {
      const sender: WebContents = e.sender;
      return sendTurn({
        ...input,
        onDelta: (text) => {
          // The window can go away mid-turn; writing to a destroyed sender throws.
          if (!sender.isDestroyed()) sender.send("studio:delta", { streamId: input.streamId, text });
        },
        onActivity: (label) => {
          if (!sender.isDestroyed()) {
            sender.send("studio:activity", { streamId: input.streamId, label });
          }
        },
      });
    },
  );
}
