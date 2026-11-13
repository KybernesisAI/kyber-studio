import { ipcInnerMessage } from "./ipcError";

/**
 * What the sign-in screen says when a sign-in does not finish (KYB-679).
 *
 * `signIn` in the store calls two handlers, `studio:signIn` and
 * `studio:awaitSignIn`, and a failure in either reaches the renderer wrapped by
 * Electron's IPC. That string used to go on screen as it stood, so a code left
 * unapproved until it expired read as
 *
 *   Error invoking remote method 'studio:awaitSignIn': Error: Sign-in failed: expired_token
 *
 * on the first screen a new user sees. This turns the failures the sign-in path
 * can produce into sentences. The raw message is for the log, not for them.
 *
 * The button left on screen after a failure is **Sign in**, so the sentences
 * name that, not "Start again", which has gone with the code.
 *
 * @returns the sentence to show, or `null` when nothing should be shown: a
 *   cancelled sign-in unwinds as an error but is the person's own choice.
 */
export function signInError(error: unknown): string | null {
  const inner = ipcInnerMessage(error instanceof Error ? error.message : String(error));
  if (/^sign-in cancelled\b/i.test(inner)) return null;

  // `pollDeviceAuth` throws the control plane's RFC 8628 slug as
  // "Sign-in failed: <slug>". Which of `expired_token` and its own "timed out"
  // sentence arrives first depends on the server's expiry, so both say the same.
  const slug = /^Sign-in failed:\s*([a-z_]+)\b/i.exec(inner)?.[1]?.toLowerCase();
  if (slug === "expired_token" || /^Sign-in timed out\b/i.test(inner)) return EXPIRED;
  if (slug === "access_denied") return DENIED;
  if (slug) return UNFINISHED;

  // The network: undici's "fetch failed", the 20 s `AbortSignal.timeout`, or a
  // reply that was not JSON (a captive portal answering with HTML, or an empty
  // body).
  if (/^fetch failed\b|aborted due to timeout|is not valid JSON|^Unexpected end of JSON input/i.test(inner)) return OFFLINE;

  // Anything else the main process threw is already a sentence of its own,
  // for example "Control plane refused the device request (HTTP 503) at …".
  return inner || UNFINISHED;
}

export const EXPIRED = "That sign-in code expired. Click Sign in for a new one.";
export const DENIED = "Sign-in was declined in the browser. Click Sign in to try again.";
export const OFFLINE = "Couldn't reach Kybernesis. Check your connection, then click Sign in again.";
export const UNFINISHED = "Sign-in didn't finish. Click Sign in to try again.";
