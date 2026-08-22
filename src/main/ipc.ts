import { ipcMain, shell, type WebContents } from "electron";
import type { Attachment } from "../shared/ipc";
import { loadState, pickFolder, saveState } from "./store";
import { dictationAvailable, transcribe } from "./dictation";
import {
  localFileExists,
  openLocalFile,
  openRemoteFile,
  revealLocalFile,
  saveRemoteFile,
} from "./deliveredFile";
import { listSessions, recordSession, replaySession } from "./sessionIndex";
import { type LocalMcpServer, authenticate, listServers, saveServers, testServer } from "./localMcp";
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
  addCustomConnector,
  startMcpSignIn,
  cancelTurn,
  connectService,
  disconnectService,
  listConnectors,
  localAccessGranted,
  manageCall,
  provisionLocalAccess,
  revokeLocalAccess,
  currentSession,
  listAgents,
  pollDeviceAuth,
  resetSession,
  sendTurn,
  signOut,
  testRemoteMcp,
  startDeviceAuth,
  cancelDeviceAuth,
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

  ipcMain.handle("studio:cancelSignIn", () => {
    cancelDeviceAuth();
    pending = null;
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

  ipcMain.handle("studio:listSessions", (_e, agent?: string) => listSessions(agent));
  ipcMain.handle(
    "studio:recordSession",
    (_e, entry: Parameters<typeof recordSession>[0]) => recordSession(entry),
  );
  ipcMain.handle(
    "studio:replaySession",
    (_e, input: { url: string; sessionId: string; limit?: number }) => replaySession(input),
  );

  ipcMain.handle("studio:loadState", (_e, name: string) => loadState(name, null));
  ipcMain.handle("studio:saveState", (_e, input: { name: string; value: unknown }) => {
    saveState(input.name, input.value);
  });
  ipcMain.handle("studio:pickFolder", () => pickFolder());

  ipcMain.handle(
    "studio:manage",
    (_e, input: { url: string; path: string; body?: unknown }) => manageCall(input),
  );
  ipcMain.handle(
    "studio:setLocalPermission",
    (_e, input: { action: LocalAction; value: LocalPermission }) => {
      setPermission(input.action, input.value);
      return readPermissions();
    },
  );

  ipcMain.handle(
    "studio:provisionLocal",
    (_e, input: { url: string; agent: string }) => provisionLocalAccess(input),
  );

  // Sign-in happens in the user's real browser, where their sessions and
  // password manager already are — never in an app window pretending to be one.
  ipcMain.handle("studio:connectors", (_e, agent: string) => listConnectors(agent));
  ipcMain.handle(
    "studio:connectService",
    (_e, input: { agent: string; slug: string; label?: string }) => connectService(input),
  );
  ipcMain.handle(
    "studio:disconnectService",
    (_e, input: { agent: string; slug: string; shared?: boolean; account?: string }) =>
      disconnectService(input),
  );

  ipcMain.handle(
    "studio:addCustomConnector",
    (
      _e,
      input: { agent: string; name: string; url: string; token?: string; shared?: boolean },
    ) => addCustomConnector(input),
  );

  ipcMain.handle(
    "studio:startMcpSignIn",
    (_event, input: { slug: string; agent: string; shared?: boolean }) => startMcpSignIn(input),
  );

  ipcMain.handle("studio:testRemoteMcp", (_e, slug: string) => testRemoteMcp(slug));

  ipcMain.handle("studio:connectMcpServer", (_e, id: string) => authenticate(id));

  ipcMain.handle("studio:testMcpServer", (_e, id: string) => testServer(id));

  ipcMain.handle("studio:mcpServers", () => listServers());
  ipcMain.handle("studio:saveMcpServers", (_e, servers: LocalMcpServer[]) => {
    saveServers(servers);
    return listServers();
  });

  ipcMain.handle("studio:openExternal", (_e, url: string) => shell.openExternal(url));

  // Files the agent handed back. The renderer passes a location the USER
  // clicked; none of these take an instruction from the model.
  ipcMain.handle("studio:fileExists", (_e, path: string) => localFileExists(path));

  // Dictation. The audio arrives as samples and leaves as text; nothing is
  // written to disk and nothing goes to a network.
  ipcMain.handle("studio:dictationAvailable", () => dictationAvailable());
  ipcMain.handle("studio:transcribe", (_e, samples: Float32Array) => transcribe(samples));
  ipcMain.handle("studio:openLocalFile", (_e, path: string) => openLocalFile(path));
  ipcMain.handle("studio:revealLocalFile", (_e, path: string) => revealLocalFile(path));
  ipcMain.handle(
    "studio:saveRemoteFile",
    (_e, input: { url: string; suggestedName: string }) => saveRemoteFile(input),
  );
  ipcMain.handle(
    "studio:openRemoteFile",
    (_e, input: { url: string; suggestedName: string }) => openRemoteFile(input),
  );

  ipcMain.handle("studio:localAccess", (_e, agent: string) => localAccessGranted(agent));

  ipcMain.handle("studio:revokeLocal", (_e, agent: string) => revokeLocalAccess(agent));

  ipcMain.handle(
    "studio:cancelTurn",
    (_e, input: { url: string; sessionId: string; turnId?: string }) => cancelTurn(input),
  );

  ipcMain.handle(
    "studio:resetSession",
    (_e, input: { url: string; sessionId?: string }) =>
      resetSession(input),
  );

  ipcMain.handle(
    "studio:send",
    (
      e,
      input: {
        url: string;
        text: string;
        attachments?: Attachment[];
        sessionId?: string;
        streamIndex?: number;
        inputResponses?: { requestId: string; optionId?: string; text?: string }[];
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
        onReset: () => {
          if (!sender.isDestroyed()) sender.send("studio:reset", { streamId: input.streamId });
        },
        onActivity: (label) => {
          if (!sender.isDestroyed()) {
            sender.send("studio:activity", { streamId: input.streamId, label });
          }
        },
        onCursor: (index) => {
          if (!sender.isDestroyed()) {
            sender.send("studio:cursor", { streamId: input.streamId, index });
          }
        },
        onTurn: (turn) => {
          if (!sender.isDestroyed()) {
            sender.send("studio:turn", { streamId: input.streamId, ...turn });
          }
        },
        onPeer: (event) => {
          if (!sender.isDestroyed()) {
            sender.send('studio:peer', { streamId: input.streamId, event });
          }
        },
        onAuthorization: (event) => {
          if (!sender.isDestroyed()) {
            sender.send("studio:authorization", { streamId: input.streamId, event });
          }
        },
        onQuestion: (request) => {
          // Logged because a question that never reaches the window is
          // indistinguishable from an agent that said nothing.
          console.log(
            `[question→ui] ${request.requestId} destroyed=${sender.isDestroyed()} stream=${input.streamId}`,
          );
          if (!sender.isDestroyed()) {
            sender.send("studio:question", { streamId: input.streamId, request });
          }
        },
      });
    },
  );
}
