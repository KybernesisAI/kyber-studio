import { after, test } from "node:test";
import assert from "node:assert/strict";

import { installBridge, sleep } from "./fixtures/session-sync-harness.mjs";

/**
 * KYB-682, on the screen: the control plane changed with **Change** while a
 * sign-in code waits.
 *
 * Main now ends that sign-in: `studio:setControlPlane` cancels the waiting
 * code, and the wait unwinds as "sign-in cancelled". The bridge here does what
 * main does. The screen must then drop the code, offer **Sign in** again for
 * the new control plane, and show no error: the person chose this, and a
 * cancellation is not a failure.
 *
 * The main-process half is tested in `sign-in-cancel-main.test.mjs`.
 */
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installBridge();
const { useStore } = await import("@/lib/store");
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SignIn } = await import(process.env.SIGNIN ?? "../src/renderer/src/components/SignIn.tsx");

after(() => window.close());

const DEFAULT_CP = "https://cp.example";
// How Electron's IPC delivers main's cancellation of the waiting code.
const CANCELLED = "Error invoking remote method 'studio:awaitSignIn': Error: sign-in cancelled";
// And of a code still being requested at the change.
const CANCELLED_START = "Error invoking remote method 'studio:signIn': Error: sign-in cancelled";

const button = (host, label) => [...host.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
const shownCode = (host) => host.querySelector(".signin__code")?.textContent ?? null;
const shownError = (host) => host.querySelector(".signin__error")?.textContent ?? null;
const issuerLine = (host) => host.querySelector(".signin__issuer")?.textContent ?? null;

/** Types into a React-controlled input, as a person would. */
function typeInto(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

/**
 * `signIn` hands out CODE-1, CODE-2, …; each wait stays pending. Changing the
 * control plane ends the waiting code as main does, by rejecting its wait
 * with the cancellation.
 */
function bridge({ holdSignIn = false } = {}) {
  const calls = [];
  const waits = [];
  const starts = [];
  let n = 0;
  let cp = DEFAULT_CP;
  const state = () => ({ url: cp, isDefault: cp === DEFAULT_CP, default: DEFAULT_CP });
  window.studio.signIn = async () => {
    n += 1;
    calls.push(`signIn#${n}`);
    // Held: the code is still being requested when the control plane changes.
    if (holdSignIn) await new Promise((resolve, reject) => starts.push({ resolve, reject }));
    await sleep(10);
    return { userCode: `CODE-${n}`, verificationUri: `https://verify.example/${n}` };
  };
  window.studio.awaitSignIn = () =>
    new Promise((resolve, reject) => {
      calls.push("await");
      waits.push({ resolve, reject });
    });
  window.studio.cancelSignIn = async () => void calls.push("cancel");
  window.studio.controlPlane = async () => state();
  window.studio.setControlPlane = async (url) => {
    calls.push(`setControlPlane:${url}`);
    cp = url === null ? DEFAULT_CP : url;
    for (const w of waits.splice(0)) w.reject(new Error(CANCELLED));
    for (const s of starts.splice(0)) s.reject(new Error(CANCELLED_START));
    return state();
  };
  return { calls };
}

async function changeControlPlane(host, url) {
  await act(async () => button(host, "Change").click());
  const input = host.querySelector(".signin__issuer--editing input");
  assert.ok(input, "the control-plane editor did not open");
  await act(async () => typeInto(input, url));
  await act(async () => button(host, "Use this").click());
  await act(async () => sleep(40));
}

function assertSignInOffered(host) {
  assert.equal(shownCode(host), null, "the old control plane's code is on screen");
  const signIn = button(host, "Sign in");
  assert.ok(signIn, "Sign in is not offered after the change");
  assert.equal(signIn.disabled, false, "Sign in is disabled after the change");
  assert.match(issuerLine(host) ?? "", /other-cp\.example/, "the new control plane is not shown");
  assert.equal(useStore.getState().authError, null, `a sign-in error was set: ${useStore.getState().authError}`);
  assert.equal(shownError(host), null, `an error was shown: ${shownError(host)}`);
  assert.equal(useStore.getState().authState, "signed-out");
}

test("changing the control plane while a code waits drops the code and offers Sign in, with no error", async () => {
  const { calls } = bridge();
  useStore.setState({ authState: "signed-out", account: null, authError: null });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(SignIn)));
  await act(async () => button(host, "Sign in").click());
  await act(async () => sleep(40));
  assert.equal(shownCode(host), "CODE-1", "fixture is wrong: no code is waiting");

  await changeControlPlane(host, "https://other-cp.example");
  assert.deepEqual(calls, ["signIn#1", "await", "setControlPlane:https://other-cp.example"]);
  assertSignInOffered(host);
  // And it stays that way: nothing from the old code arrives later.
  await act(async () => sleep(200));
  assertSignInOffered(host);

  await act(async () => root.unmount());
});

test("changing the control plane while a code is being requested offers Sign in, with no error", async () => {
  const { calls } = bridge({ holdSignIn: true });
  useStore.setState({ authState: "signed-out", account: null, authError: null });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(SignIn)));
  await act(async () => button(host, "Sign in").click());
  await act(async () => sleep(40));
  assert.ok(button(host, "Opening your browser…"), "fixture is wrong: the code is not being requested");

  await changeControlPlane(host, "https://other-cp.example");
  assert.deepEqual(calls, ["signIn#1", "setControlPlane:https://other-cp.example"]);
  assertSignInOffered(host);
  await act(async () => sleep(200));
  assertSignInOffered(host);

  await act(async () => root.unmount());
});
