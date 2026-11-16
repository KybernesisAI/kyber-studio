import { after, test } from "node:test";
import assert from "node:assert/strict";

import { installBridge, sleep } from "./fixtures/session-sync-harness.mjs";

/**
 * KYB-680, on the screen: "Start again" while a code is waiting.
 *
 * The button was disabled for the whole wait, which is the only time it is on
 * screen, so it had never worked. Enabling it is not enough on its own: the
 * abandoned wait is still unwinding when the new one starts, and its clean-up
 * (clearing the code, clearing `busy`, setting `authError`) used to land on
 * the NEW attempt. These tests mount the real screen with the real store and
 * make the old wait settle only after the new code is showing.
 *
 * `SIGNIN` points at another copy of the component, so the race test can be
 * run against a version with only `disabled={busy}` removed. That is how it
 * was recorded failing on the race rather than on the disabled button.
 */
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installBridge();
const { useStore } = await import("@/lib/store");
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SignIn } = await import(process.env.SIGNIN ?? "../src/renderer/src/components/SignIn.tsx");

after(() => window.close());

const button = (host, label) => [...host.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
const shownCode = (host) => host.querySelector(".signin__code")?.textContent ?? null;
const shownError = (host) => host.querySelector(".signin__error")?.textContent ?? null;

/**
 * A bridge whose every `awaitSignIn` stays pending until the test settles it,
 * and whose `signIn` hands out CODE-1, CODE-2, … in order.
 */
function bridge() {
  const calls = [];
  const waits = [];
  let n = 0;
  window.studio.signIn = async () => {
    n += 1;
    calls.push(`signIn#${n}`);
    await sleep(10);
    return { userCode: `CODE-${n}`, verificationUri: `https://verify.example/${n}` };
  };
  window.studio.awaitSignIn = () =>
    new Promise((resolve, reject) => {
      calls.push("await");
      waits.push({ resolve, reject });
    });
  window.studio.cancelSignIn = async () => {
    calls.push("cancel");
  };
  return { calls, waits };
}

async function mountAndPressSignIn() {
  useStore.setState({ authError: null });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(SignIn)));
  await act(async () => button(host, "Sign in").click());
  await act(async () => sleep(40));
  return { host, unmount: () => act(async () => root.unmount()) };
}

test("while a code waits, Start again is live and shows a new code, with no error", async () => {
  const { calls, waits } = bridge();
  const { host, unmount } = await mountAndPressSignIn();
  assert.equal(shownCode(host), "CODE-1");

  const startAgain = button(host, "Start again");
  assert.ok(startAgain, "the code view has no Start again button");
  assert.equal(startAgain.disabled, false, "Start again is disabled while the code waits");

  await act(async () => startAgain.click());
  await act(async () => sleep(40));

  assert.deepEqual(calls, ["signIn#1", "await", "cancel", "signIn#2", "await"]);
  assert.equal(shownCode(host), "CODE-2");
  assert.equal(shownError(host), null);
  assert.equal(button(host, "Start again")?.disabled, false, "Start again is not live again for the new code");

  for (const w of waits) w.reject(new Error("Error invoking remote method 'studio:awaitSignIn': Error: sign-in cancelled"));
  await act(async () => sleep(10));
  await unmount();
});

test("the countdown starts again from 10:00 for the new code", async () => {
  const { waits } = bridge();
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const { host, unmount } = await mountAndPressSignIn();
    offset = 125_000;
    await act(async () => sleep(1_100));
    assert.match(host.querySelector(".signin__left")?.textContent ?? "", /7:5\d left/);

    await act(async () => button(host, "Start again").click());
    await act(async () => sleep(40));
    assert.equal(shownCode(host), "CODE-2");
    assert.match(host.querySelector(".signin__left")?.textContent ?? "", /10:00 left/);

    for (const w of waits) w.reject(new Error("sign-in cancelled"));
    await act(async () => sleep(10));
    await unmount();
  } finally {
    Date.now = realNow;
  }
});

for (const [why, late] of [
  ["a cancellation", "Error invoking remote method 'studio:awaitSignIn': Error: sign-in cancelled"],
  // The worst case: the old code's real failure arriving just as it is abandoned.
  ["an expired code", "Error invoking remote method 'studio:awaitSignIn': Error: Sign-in failed: expired_token"],
]) {
  test(`the old wait settling late with ${why} does not disturb the new code`, async (t) => {
    t.mock.method(console, "warn", () => {});
    const { waits } = bridge();
    const { host, unmount } = await mountAndPressSignIn();
    await act(async () => button(host, "Start again").click());
    await act(async () => sleep(40));
    assert.equal(shownCode(host), "CODE-2", "fixture is wrong: the new code never showed");
    assert.equal(waits.length, 2, "fixture is wrong: the new wait never started");

    // Only now does the abandoned wait unwind.
    await act(async () => waits[0].reject(new Error(late)));
    await act(async () => sleep(30));

    assert.equal(shownCode(host), "CODE-2", "the old wait cleared the new code");
    assert.equal(shownError(host), null, "the old wait's failure was shown against the new code");
    assert.equal(useStore.getState().authError, null);
    assert.equal(button(host, "Sign in"), undefined, "the screen went back to Sign in while the new code still waits");
    assert.equal(button(host, "Start again")?.disabled, false);

    // And the new wait is still the one that decides.
    await act(async () => waits[1].reject(new Error(late)));
    await act(async () => sleep(30));
    assert.equal(shownCode(host), null);
    assert.ok(button(host, "Sign in"));
    await unmount();
  });
}

test("in Electron's order, nothing can start a third code while the second is being fetched", async (t) => {
  // In a real process the cancel's reply comes first and the old wait's
  // rejection follows at once, BEFORE the new code is back from the control
  // plane. The old attempt must not hand back a live button in that gap.
  t.mock.method(console, "warn", () => {});
  const { calls, waits } = bridge();
  let releaseSecond;
  const { host, unmount } = await mountAndPressSignIn();
  window.studio.cancelSignIn = async () => {
    calls.push("cancel");
    // The old wait's rejection is its own IPC reply, so it lands just after
    // the cancel's, once the new attempt has begun.
    void sleep(5).then(() =>
      waits[0].reject(new Error("Error invoking remote method 'studio:awaitSignIn': Error: sign-in cancelled")),
    );
  };
  window.studio.signIn = async () => {
    calls.push("signIn#2");
    await new Promise((resolve) => (releaseSecond = resolve));
    return { userCode: "CODE-2", verificationUri: "https://verify.example/2" };
  };

  await act(async () => button(host, "Start again").click());
  await act(async () => sleep(30));
  // Only the buttons that start a code, under every label they carry: the
  // Sign in button reads "Opening your browser…" while busy. ("Change", for
  // the control plane, is live throughout, as it is on main.)
  const starters = () =>
    [...host.querySelectorAll("button")].filter((b) =>
      ["Sign in", "Opening your browser…", "Start again"].includes(b.textContent.trim()),
    );
  assert.ok(starters().length > 0, "fixture is wrong: no button that starts a code is on screen in the gap");
  const live = starters().filter((b) => !b.disabled).map((b) => b.textContent.trim());
  assert.deepEqual(live, [], `a button was live while the second code was being fetched: ${JSON.stringify(live)}`);
  assert.equal(shownError(host), null);

  // A second click in that gap starts nothing.
  for (const b of starters()) await act(async () => b.click());
  await act(async () => sleep(30));
  assert.deepEqual(calls, ["signIn#1", "await", "cancel", "signIn#2"]);

  await act(async () => releaseSecond());
  await act(async () => sleep(30));
  assert.equal(shownCode(host), "CODE-2");
  assert.equal(button(host, "Start again")?.disabled, false);
  for (const w of waits.slice(1)) w.reject(new Error("sign-in cancelled"));
  await act(async () => sleep(10));
  await unmount();
});

test("a double click on Start again cancels once and fetches one new code", async () => {
  const { calls, waits } = bridge();
  const { host, unmount } = await mountAndPressSignIn();
  // A cancel held open until the test releases it, so the second click lands
  // while the first is still cancelling, however late timers fire. Two
  // separate events, as a real double click is, so React renders between them.
  const releases = [];
  window.studio.cancelSignIn = async () => {
    calls.push("cancel");
    await new Promise((resolve) => releases.push(resolve));
  };
  const startAgain = button(host, "Start again");
  await act(async () => startAgain.click());
  await act(async () => startAgain.click());
  await act(async () => releases.forEach((release) => release()));
  await act(async () => sleep(40));
  assert.deepEqual(calls, ["signIn#1", "await", "cancel", "signIn#2", "await"]);
  assert.equal(shownCode(host), "CODE-2");
  for (const w of waits) w.reject(new Error("sign-in cancelled"));
  await act(async () => sleep(10));
  await unmount();
});
