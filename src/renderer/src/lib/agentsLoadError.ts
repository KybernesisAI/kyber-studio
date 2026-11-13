import { ipcInnerMessage } from "./ipcError";

/**
 * What the sidebar says when the agent list could not be loaded (KYB-669).
 *
 * The failure reaches the renderer as Electron's IPC wrapping of whatever the
 * main process threw, for example
 *
 *   Error invoking remote method 'studio:listAgents': TypeError: fetch failed
 *
 * and that string used to be put on screen as it stood. This turns it into a
 * sentence a person can act on. The raw message is for the log, not for them.
 *
 * `listAgents` in `src/main/controlPlane.ts` throws its own sentences for the
 * cases it recognises ("Session expired. Sign in again.", "Not signed in.",
 * "Could not list agents (HTTP n)."); everything else that reaches here is the
 * network: no route, DNS, a refused connection, or its 20 s timeout.
 *
 * "Not signed in." does NOT mean the sign-in has ended. `activeSession` says it
 * whenever the stored token is within 30 s of expiry and the refresh fails,
 * and offline the refresh always fails. Tokens last an hour, so opening Studio
 * offline more than an hour after it last refreshed says "Not signed in." for
 * exactly the reason "fetch failed" does, and recovers the same way. The
 * sign-in has only really ended when the main process dropped the stored
 * session (a refresh answered 401 or 403), which `sessionStored` reports.
 */

/** Whether the main process said "Not signed in.", the one case that needs `sessionStored`. */
export function isNotSignedIn(error: unknown): boolean {
  return /^Not signed in\b/i.test(ipcInnerMessage(error instanceof Error ? error.message : String(error)));
}

const EXPIRED = "Your sign-in has expired. Sign out from the account menu, then sign in again.";

/**
 * @param sessionStored whether a session is still stored on this machine
 *   (`window.studio.session()`); only consulted for "Not signed in.".
 */
export function agentsLoadError(error: unknown, { sessionStored = true }: { sessionStored?: boolean } = {}): string {
  const raw = error instanceof Error ? error.message : String(error);
  const inner = ipcInnerMessage(raw);
  // Retrying cannot help with these, so the sentence does not promise it.
  if (/^Session expired\b/i.test(inner)) return EXPIRED;
  if (/^Not signed in\b/i.test(inner) && !sessionStored) return EXPIRED;
  const http = /^Could not list agents \(HTTP (\d{3})\)/.exec(inner);
  if (http) {
    return `Kybernesis could not load your agents (HTTP ${http[1]}). Retrying…`;
  }
  return "Couldn't reach Kybernesis to load your agents. Retrying…";
}
