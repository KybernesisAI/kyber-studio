/**
 * Realtime voice ("orb") — main-process half.
 *
 * The agent owns voice now, via the @kybernesis/voice channel: it holds its own
 * OpenAI key and mints the realtime session. This app only opens the orb window,
 * relays the browser's SDP offer to the agent's voice route (voiceSession in
 * controlPlane, authenticated with the same control-plane identity as every
 * other door), and bridges the model's client-delegation back to the agent's
 * own eve session via voiceAsk. No OpenAI key ever lives in this app.
 *
 * The WebRTC connection itself runs in the orb renderer (it needs a browser
 * context); this module is the window + the delegation bridge.
 */

import { join } from "node:path";
import { BrowserWindow, shell } from "electron";
import { is } from "@electron-toolkit/utils";
import { sendTurn, voiceSession } from "./controlPlane";

export interface VoiceContext {
  agentId: string;
  agentUrl: string;
  agentName: string;
  sessionId?: string;
  /** The spoken voice for this agent (OpenAI Live voice name). */
  voice?: string;
}

let orbWindow: BrowserWindow | null = null;
let orbContext: VoiceContext | null = null;

/**
 * Complete the Live WebRTC handshake by relaying the offer to the agent's own
 * voice route, which mints the session with the agent's key and returns the
 * answer SDP.
 */
export async function createLiveSession(input: { sdp: string }): Promise<{ sdp: string }> {
  if (!orbContext) throw new Error("No active voice session.");
  return voiceSession({ url: orbContext.agentUrl, sdp: input.sdp, voice: orbContext.voice });
}

/** What agent/session the current orb session is bridged to. */
export function voiceContext(): VoiceContext | null {
  return orbContext;
}

/**
 * Run a delegated request on the bound agent session and return its reply, for
 * the orb to speak. Runs on the agent's own voice session; activity labels are
 * forwarded to the orb so it can narrate progress while the agent works.
 */
export async function voiceAsk(input: {
  text: string;
}): Promise<{ reply: string; sessionId?: string; askedQuestion: boolean }> {
  if (!orbContext) throw new Error("No active voice session.");
  console.log(`[orb] voiceAsk → ${orbContext.agentName}: ${input.text.slice(0, 160)}`);
  const forward = (label: string | null): void => {
    if (orbWindow && !orbWindow.isDestroyed()) orbWindow.webContents.send("studio:voice-activity", label);
  };
  const result = await sendTurn({
    url: orbContext.agentUrl,
    text: input.text,
    sessionId: orbContext.sessionId,
    onDelta: () => {},
    onActivity: forward,
    onCursor: () => {},
    onQuestion: (q) => forward(`asked: ${q.prompt}`),
    onAuthorization: (a) => forward(`sign-in needed: ${a.name}`),
  });
  if (result.sessionId) orbContext = { ...orbContext, sessionId: result.sessionId };
  console.log(`[orb] voiceAsk ← reply ${result.reply.length} chars, askedQuestion=${result.askedQuestion}`);
  return {
    reply: result.askedQuestion
      ? "I need to ask a follow-up question. Please check the Studio window to answer it."
      : result.reply,
    sessionId: result.sessionId,
    askedQuestion: result.askedQuestion,
  };
}

/**
 * Toggle the orb from the composer button: open it when closed, close it when
 * open. Main owns the window, so this stays correct however it was closed
 * (the × button, Esc, or a previous toggle).
 */
export function toggleOrbWindow(context: VoiceContext): boolean {
  if (orbWindow && !orbWindow.isDestroyed()) {
    closeOrbWindow();
    return false;
  }
  openOrbWindow(context);
  return true;
}

/** Open (or focus) the floating transparent orb window and bind it to an agent. */
export function openOrbWindow(context: VoiceContext): void {
  // The voice runs on the agent's OWN session, not the text chat's: reusing the
  // session the main window is actively watching left the delegated turn queued
  // behind the watch and it never started (150s timeout).
  orbContext = { ...context, sessionId: undefined };
  if (orbWindow && !orbWindow.isDestroyed()) {
    orbWindow.webContents.send("studio:voice-context", orbContext);
    orbWindow.show();
    orbWindow.focus();
    return;
  }
  orbWindow = new BrowserWindow({
    width: 240,
    height: 240,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
    },
  });
  orbWindow.setAlwaysOnTop(true, "floating");
  orbWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  orbWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  orbWindow.webContents.on("console-message", (_e, _level, message) => {
    if (message.startsWith("[")) console.log(`[orb] ${message}`);
  });
  orbWindow.on("ready-to-show", () => orbWindow?.show());
  orbWindow.on("closed", () => {
    orbWindow = null;
    orbContext = null;
  });

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    void orbWindow.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}/orb.html`);
  } else {
    void orbWindow.loadFile(join(__dirname, "../renderer/orb.html"));
  }
}

/**
 * Move the orb window by a screen-space delta. Driven from the renderer's
 * click-vs-drag handler so the orb itself can be grabbed to move the window,
 * while a click with no movement stays a mute toggle.
 */
export function moveOrbWindow(dx: number, dy: number): void {
  if (!orbWindow || orbWindow.isDestroyed()) return;
  const [x, y] = orbWindow.getPosition();
  orbWindow.setPosition(Math.round(x + dx), Math.round(y + dy));
}

export function closeOrbWindow(): void {
  if (orbWindow && !orbWindow.isDestroyed()) orbWindow.close();
  orbWindow = null;
  orbContext = null;
}
