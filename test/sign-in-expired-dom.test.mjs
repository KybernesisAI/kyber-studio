import { after, test } from "node:test";
import assert from "node:assert/strict";

import { installBridge, sleep } from "./fixtures/session-sync-harness.mjs";

/**
 * KYB-679, on the screen: the sign-in screen, MOUNTED with the real store and
 * PRESSED, when the code is never approved.
 *
 * Measured in the KYB-632 UAT: the code view went, and under the Sign in
 * button was Electron's IPC wrapping of the control plane's OAuth slug. That
 * string is the rejection here, verbatim.
 */
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const MEASURED = "Error invoking remote method 'studio:awaitSignIn': Error: Sign-in failed: expired_token";

installBridge();
const { useStore } = await import("@/lib/store");
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SignIn } = await import("../src/renderer/src/components/SignIn.tsx");

after(() => window.close());

async function mountSignIn() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(SignIn)));
  return { host, unmount: () => act(async () => root.unmount()) };
}

const signInButton = (host) => [...host.querySelectorAll("button")].find((b) => b.textContent === "Sign in");

async function pressSignInAndFail(t, rejection) {
  const warned = t.mock.method(console, "warn", () => {});
  window.studio.awaitSignIn = async () => {
    await sleep(10);
    throw new Error(rejection);
  };
  useStore.setState({ authError: null });
  const { host, unmount } = await mountSignIn();
  await act(async () => signInButton(host).click());
  await act(async () => sleep(50));
  const logged = warned.mock.calls.map((c) => c.arguments.map(String).join(" "));
  return { host, unmount, logged };
}

test("an expired code shows one plain sentence, and none of the raw error", async (t) => {
  const { host, unmount, logged } = await pressSignInAndFail(t, MEASURED);
  const text = host.textContent;
  assert.match(text, /That sign-in code expired\. Click Sign in for a new one\./);
  assert.doesNotMatch(text, /Error invoking remote method/);
  assert.doesNotMatch(text, /studio:awaitSignIn/);
  assert.doesNotMatch(text, /expired_token/);
  assert.ok(signInButton(host), "the Sign in button must be back, so the sentence's instruction can be followed");

  // The raw error is still there for whoever reads the terminal. The leading
  // `[` is what makes the main process forward a renderer line to it.
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^\[auth\] sign-in failed: /);
  assert.ok(logged[0].includes(MEASURED), "the log line must carry the raw error verbatim");
  await unmount();
});

test("an unrecognised failure shows no IPC wrapper either", async (t) => {
  const { host, unmount } = await pressSignInAndFail(
    t,
    "Error invoking remote method 'studio:awaitSignIn': Error: Sign-in failed: invalid_grant",
  );
  assert.doesNotMatch(host.textContent, /Error invoking remote method|studio:|invalid_grant/);
  assert.match(host.textContent, /Sign-in didn't finish\. Click Sign in to try again\./);
  await unmount();
});

test("a cancelled sign-in leaves no error on screen and logs nothing", async (t) => {
  const { host, unmount, logged } = await pressSignInAndFail(
    t,
    "Error invoking remote method 'studio:awaitSignIn': Error: sign-in cancelled",
  );
  assert.equal(host.querySelector(".signin__error"), null);
  assert.equal(useStore.getState().authError, null);
  assert.deepEqual(logged, []);
  await unmount();
});

test("a sign-in that succeeds after a failed one clears the sentence", async () => {
  useStore.setState({ authError: "That sign-in code expired. Click Sign in for a new one." });
  window.studio.awaitSignIn = async () => ({ email: "p@example.com", orgName: "o" });
  const ok = await useStore.getState().signIn(() => {});
  assert.equal(ok, true);
  assert.equal(useStore.getState().authError, null);
  assert.equal(useStore.getState().authState, "signed-in");
});
