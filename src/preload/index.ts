import { electronAPI } from "@electron-toolkit/preload";
import { contextBridge, ipcRenderer } from "electron";
import type { StudioApi } from "../shared/ipc";

/**
 * The only bridge. Tokens live in the main process and never reach the
 * renderer — web content gets answers, not credentials.
 */
const studio: StudioApi = {
  session: () => ipcRenderer.invoke("studio:session"),
  signIn: () => ipcRenderer.invoke("studio:signIn"),
  cancelSignIn: () => ipcRenderer.invoke("studio:cancelSignIn"),
  awaitSignIn: () => ipcRenderer.invoke("studio:awaitSignIn"),
  signOut: () => ipcRenderer.invoke("studio:signOut"),
  listAgents: () => ipcRenderer.invoke("studio:listAgents"),
  send: (input) => ipcRenderer.invoke("studio:send", input),
  agentInfo: (url) => ipcRenderer.invoke("studio:agentInfo", url),
  localAnswer: (input) => ipcRenderer.invoke("studio:localAnswer", input),
  localPermissions: () => ipcRenderer.invoke("studio:localPermissions"),
  listSessions: (agent) => ipcRenderer.invoke("studio:listSessions", agent),
  recordSession: (entry) => ipcRenderer.invoke("studio:recordSession", entry),
  replaySession: (input) => ipcRenderer.invoke("studio:replaySession", input),
  loadState: (name) => ipcRenderer.invoke("studio:loadState", name),
  saveState: (input) => ipcRenderer.invoke("studio:saveState", input),
  pickFolder: () => ipcRenderer.invoke("studio:pickFolder"),
  manage: (input) => ipcRenderer.invoke("studio:manage", input),
  setLocalPermission: (input) => ipcRenderer.invoke("studio:setLocalPermission", input),
  onLocalAsk: (handler) => {
    const listener = (_e: unknown, ask: Parameters<typeof handler>[0]): void => handler(ask);
    ipcRenderer.on("studio:local-ask", listener);
    return () => ipcRenderer.off("studio:local-ask", listener);
  },
  onLocalDone: (handler) => {
    const listener = (_e: unknown, p: { id: string }): void => handler(p);
    ipcRenderer.on("studio:local-done", listener);
    return () => ipcRenderer.off("studio:local-done", listener);
  },
  onCursor: (handler) => {
    const listener = (_e: unknown, payload: { streamId: string; index: number }): void => handler(payload);
    ipcRenderer.on("studio:cursor", listener);
    return () => ipcRenderer.off("studio:cursor", listener);
  },
  provisionLocal: (input) => ipcRenderer.invoke("studio:provisionLocal", input),
  localAccess: (agent) => ipcRenderer.invoke("studio:localAccess", agent),
  revokeLocal: (agent) => ipcRenderer.invoke("studio:revokeLocal", agent),
  cancelTurn: (input) => ipcRenderer.invoke("studio:cancelTurn", input),
  resetSession: (input) => ipcRenderer.invoke("studio:resetSession", input),
  onTurn: (handler) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]): void => handler(payload);
    ipcRenderer.on("studio:turn", listener);
    return () => ipcRenderer.off("studio:turn", listener);
  },
  connectors: (agent) => ipcRenderer.invoke("studio:connectors", agent),
  connectService: (input) => ipcRenderer.invoke("studio:connectService", input),
  disconnectService: (input) => ipcRenderer.invoke("studio:disconnectService", input),
  addCustomConnector: (input) => ipcRenderer.invoke("studio:addCustomConnector", input),
  connectMcpServer: (id) => ipcRenderer.invoke("studio:connectMcpServer", id),
  testRemoteMcp: (slug) => ipcRenderer.invoke("studio:testRemoteMcp", slug),
  testMcpServer: (id) => ipcRenderer.invoke("studio:testMcpServer", id),
  mcpServers: () => ipcRenderer.invoke("studio:mcpServers"),
  saveMcpServers: (servers) => ipcRenderer.invoke("studio:saveMcpServers", servers),
  updaterState: () => ipcRenderer.invoke("studio:updaterState"),
  updaterCheck: () => ipcRenderer.invoke("studio:updaterCheck"),
  updaterDownload: () => ipcRenderer.invoke("studio:updaterDownload"),
  updaterInstall: () => ipcRenderer.invoke("studio:updaterInstall"),
  onUpdater: (handler) => {
    const listener = (_e: unknown, state: Parameters<typeof handler>[0]): void => handler(state);
    ipcRenderer.on("studio:updater", listener);
    return () => ipcRenderer.off("studio:updater", listener);
  },
  openExternal: (url) => ipcRenderer.invoke("studio:openExternal", url),
  onAuthorization: (handler) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]): void => handler(payload);
    ipcRenderer.on("studio:authorization", listener);
    return () => ipcRenderer.off("studio:authorization", listener);
  },
  onPeer: (handler) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]): void => handler(payload);
    ipcRenderer.on('studio:peer', listener);
    return () => ipcRenderer.off('studio:peer', listener);
  },
  onQuestion: (handler) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]): void => handler(payload);
    ipcRenderer.on("studio:question", listener);
    return () => ipcRenderer.off("studio:question", listener);
  },
  onReset: (handler) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]): void => handler(payload);
    ipcRenderer.on("studio:reset", listener);
    return () => ipcRenderer.off("studio:reset", listener);
  },
  onActivity: (handler) => {
    const listener = (_e: unknown, payload: { streamId: string; label: string | null }): void =>
      handler(payload);
    ipcRenderer.on("studio:activity", listener);
    return () => ipcRenderer.off("studio:activity", listener);
  },
  onDelta: (handler) => {
    const listener = (_e: unknown, payload: { streamId: string; text: string }): void =>
      handler(payload);
    ipcRenderer.on("studio:delta", listener);
    return () => ipcRenderer.off("studio:delta", listener);
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("studio", studio);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-expect-error -- contextIsolation disabled
  window.electron = electronAPI;
  // @ts-expect-error -- contextIsolation disabled
  window.studio = studio;
}
