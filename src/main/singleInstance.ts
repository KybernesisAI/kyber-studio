/**
 * What a second launch does to the window the first launch already has open.
 *
 * @remarks
 * `app.requestSingleInstanceLock()` is the lock itself and it cannot be
 * exercised outside a running Electron app — it talks to a real OS-level
 * primitive, and a second process is the only thing that can contend for it.
 * That half is proven by UAT and says so in KYB-575 rather than pretending
 * otherwise.
 *
 * What CAN be tested is the decision this file holds: given a window that is
 * minimised, hidden, or already in front, which of `restore`, `show` and
 * `focus` should be called, in what order, and what happens when there is no
 * window at all. That is the part with branches in it, so that is the part
 * worth a test.
 *
 * No Electron import: the window is passed in, exactly as `credentialStorage.ts`
 * takes `safeStorage` rather than importing it, and for the same stated reason
 * — it keeps the logic loadable by `node --test`, which is the difference
 * between this being tested and being hoped at.
 */

/** The parts of Electron's `BrowserWindow` this file needs, and nothing more. */
export type FocusableWindow = {
  isMinimized: () => boolean;
  restore: () => void;
  isVisible: () => boolean;
  show: () => void;
  focus: () => void;
};

/**
 * `no-window` is not a failure. On macOS the app outlives its last window
 * (`window-all-closed` deliberately does not quit there), so a second launch can
 * legitimately arrive with nothing to focus — and the right answer then is to
 * open a window, not to do nothing. Returning the outcome rather than a boolean
 * makes the caller say which case it is handling.
 */
export type SecondLaunchOutcome = "focused" | "no-window";

/**
 * Bring an existing window back to the person who just tried to launch a second
 * copy.
 *
 * The order is load-bearing and is asserted by the tests. A minimised window
 * cannot usefully take focus, so `restore` comes first; a hidden window has no
 * surface to focus, so `show` comes before `focus`. Calling `focus` first works
 * on some platforms and silently does nothing on others, which is the kind of
 * difference that only shows up on the machine you do not have.
 *
 * Both guards are deliberate rather than defensive. `restore` on a window that
 * is not minimised, and `show` on one already visible, are not no-ops on every
 * platform — `show` in particular raises and focuses — so calling them
 * unconditionally would make a second launch move a window the person had
 * deliberately left where it was.
 */
export function focusExistingWindow(win: FocusableWindow | null): SecondLaunchOutcome {
  if (!win) return "no-window";
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  return "focused";
}
