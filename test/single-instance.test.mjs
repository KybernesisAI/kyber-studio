import { test } from "node:test";
import assert from "node:assert/strict";

import { focusExistingWindow } from "../src/main/singleInstance.ts";

/**
 * What these tests exist to catch.
 *
 * KYB-575 measured the defect rather than predicting it: two Studio instances
 * ran side by side on Linux, both reaching the keyring, nothing preventing or
 * noticing the second. The lock that fixes that —
 * `app.requestSingleInstanceLock()` — cannot be tested here, because it talks to
 * an OS primitive and only a genuine second process can contend for it. That
 * half is UAT and the ticket says so.
 *
 * This is the other half: the decision about what to do with the window that is
 * already open. It has four branches and an order that matters, which is
 * precisely the shape that rots silently if nothing pins it.
 *
 * The fake records only the calls that CHANGE the window — `restore`, `show`,
 * `focus` — and not the queries. A test that asserted on `isMinimized` being
 * called would fail when someone reorganised the guards without changing what
 * the user sees, which is a test that costs more than it catches.
 */
function fakeWindow({ minimized = false, visible = true } = {}) {
  const calls = [];
  return {
    calls,
    isMinimized: () => minimized,
    restore: () => {
      calls.push("restore");
      minimized = false;
    },
    isVisible: () => visible,
    show: () => {
      calls.push("show");
      visible = true;
    },
    focus: () => calls.push("focus"),
  };
}

test("a second launch with no window open asks the caller to open one", () => {
  // The macOS case, and the reason this returns an outcome rather than a
  // boolean. `window-all-closed` does not quit on darwin, so the app can be
  // running with nothing on screen; answering "no-window" is what lets the
  // caller create one instead of silently doing nothing.
  assert.equal(focusExistingWindow(null), "no-window");
});

test("a minimised window is restored, then focused", () => {
  const win = fakeWindow({ minimized: true, visible: true });
  assert.equal(focusExistingWindow(win), "focused");
  assert.deepEqual(win.calls, ["restore", "focus"]);
});

test("a hidden window is shown, then focused", () => {
  const win = fakeWindow({ minimized: false, visible: false });
  assert.equal(focusExistingWindow(win), "focused");
  assert.deepEqual(win.calls, ["show", "focus"]);
});

test("a window already in front is only focused", () => {
  // The guards are the point. `show` on a visible window raises it, and
  // `restore` is not a no-op everywhere — calling either unconditionally would
  // make a second launch move a window the person deliberately left alone.
  const win = fakeWindow({ minimized: false, visible: true });
  assert.equal(focusExistingWindow(win), "focused");
  assert.deepEqual(win.calls, ["focus"]);
});

test("restore comes before show, and both come before focus", () => {
  // The order is load-bearing and platform-dependent in a way that does not
  // show up locally: focusing a minimised window works on some window managers
  // and silently does nothing on others. Pinning the sequence is the only way
  // that stays true on the machine we do not have.
  const win = fakeWindow({ minimized: true, visible: false });
  assert.equal(focusExistingWindow(win), "focused");
  assert.deepEqual(win.calls, ["restore", "show", "focus"]);
});

test("every window, in every state, reports focused", () => {
  // The outcome drives whether the caller creates a window. Reporting
  // "no-window" for a window that exists would open a second one on every
  // second launch — the opposite of this ticket.
  for (const state of [
    { minimized: false, visible: true },
    { minimized: true, visible: true },
    { minimized: false, visible: false },
    { minimized: true, visible: false },
  ]) {
    assert.equal(focusExistingWindow(fakeWindow(state)), "focused", JSON.stringify(state));
  }
});
