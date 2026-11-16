import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { installBridge, sleep } from "./fixtures/session-sync-harness.mjs";

/**
 * KYB-681, on the screen: Start again clicked in the moment between main
 * saving the first session and the renderer hearing about it.
 *
 * Main now refuses the second `studio:signIn` with "already signed in", since
 * the app holds a session. The screen must end signed in as the first account
 * with no error, whichever arrives first: the first wait's answer, or the
 * refusal. Before the fix the refusal was shown as a sign-in error.
 *
 * `SIGNIN` points at another copy of the component, as in
 * `sign-in-start-again-dom.test.mjs`.
 */
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const bridgeState = installBridge();
const { useStore } = await import("@/lib/store");
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SignIn } = await import(process.env.SIGNIN ?? "../src/renderer/src/components/SignIn.tsx");

after(() => window.close());

const FIRST = { email: "first@account.example", orgName: "o" };
// How Electron's IPC delivers main's refusal to the renderer.
const REFUSED = "Error invoking remote method 'studio:signIn': Error: already signed in";

const button = (host, label) => [...host.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
const shownError = (host) => host.querySelector(".signin__error")?.textContent ?? null;

/**
 * The first `signIn` hands out CODE-1 and its wait stays pending until the
 * test answers it. Every later `signIn` is refused, when the test releases it,
 * because main has saved the first session by then. `session()` reads what
 * main holds.
 */
function bridge() {
  const calls = [];
  let first;
  const refusals = [];
  let held = null;
  let n = 0;
  window.studio.signIn = async () => {
    n += 1;
    calls.push(`signIn#${n}`);
    if (n === 1) return { userCode: "CODE-1", verificationUri: "https://verify.example/1" };
    await new Promise((release) => refusals.push(release));
    throw new Error(REFUSED);
  };
  window.studio.awaitSignIn = () =>
    new Promise((resolve) => {
      calls.push("await");
      first = (session) => {
        held = session;
        resolve(session);
      };
    });
  window.studio.cancelSignIn = async () => void calls.push("cancel");
  window.studio.session = async () => held;
  return {
    calls,
    approveFirst: () => first(FIRST),
    // Main saved the session before the refusal, whatever order the renderer
    // hears them in.
    saveFirstInMain: () => void (held = FIRST),
    refuse: () => refusals.splice(0).forEach((release) => release()),
  };
}

beforeEach(() => {
  useStore.setState({ authState: "signed-out", account: null, authError: null });
});

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(SignIn)));
  await act(async () => button(host, "Sign in").click());
  await act(async () => sleep(30));
  await act(async () => button(host, "Start again").click());
  await act(async () => sleep(30));
  return { host, unmount: () => act(async () => root.unmount()) };
}

const listAgentsCalls = () => bridgeState.calls.filter((c) => c === "listAgents").length;

function assertSignedInAsFirst(host) {
  const s = useStore.getState();
  assert.equal(s.authState, "signed-in");
  assert.deepEqual(s.account, { email: FIRST.email, orgName: FIRST.orgName });
  assert.equal(s.authError, null, `a sign-in error was set: ${s.authError}`);
  assert.equal(shownError(host), null, `a sign-in error was shown: ${shownError(host)}`);
}

test("the first wait answering before the refusal: signed in as the first account, no error", async () => {
  const b = bridge();
  const agentsBefore = listAgentsCalls();
  const { host, unmount } = await mount();
  assert.deepEqual(b.calls, ["signIn#1", "await", "cancel", "signIn#2"], "fixture is wrong: not in the gap");

  await act(async () => b.approveFirst());
  await act(async () => sleep(30));
  await act(async () => b.refuse());
  await act(async () => sleep(30));

  assertSignedInAsFirst(host);
  assert.equal(listAgentsCalls() - agentsBefore, 1, "the signed-in work ran other than once");
  await unmount();
});

test("the refusal arriving before the first wait answers: signed in as the first account, no error", async () => {
  const b = bridge();
  const agentsBefore = listAgentsCalls();
  const { host, unmount } = await mount();
  assert.deepEqual(b.calls, ["signIn#1", "await", "cancel", "signIn#2"], "fixture is wrong: not in the gap");

  b.saveFirstInMain();
  await act(async () => b.refuse());
  await act(async () => sleep(30));
  // Signed in already, from the session main holds, before the first wait has
  // answered.
  assertSignedInAsFirst(host);

  await act(async () => b.approveFirst());
  await act(async () => sleep(30));
  assertSignedInAsFirst(host);
  assert.equal(listAgentsCalls() - agentsBefore, 1, "the signed-in work ran other than once");
  await unmount();
});
