import { after, test } from "node:test";
import assert from "node:assert/strict";

import { REMOTE_AGENT, installBridge, sleep } from "./fixtures/session-sync-harness.mjs";

/**
 * KYB-669: the retry is for a list that FAILED to load, not one still loading.
 * A focus while `signedIn` is waiting on a slow control plane must not start a
 * second `listAgents` alongside the first.
 *
 * Signed in once and out again first: the focus listeners are attached at the
 * end of the FIRST sign-in, so only a later sign-in in the same window can
 * receive a focus while its list is loading. A first-sign-in version of this
 * passes with or without the guard and tests nothing (measured).
 */
const bridge = installBridge({ stored: true });
const { useStore } = await import("@/lib/store");

after(() => window.close());

test("a focus during a sign-in's slow load does not ask for the agent list a second time", async () => {
  await useStore.getState().bootstrap();
  await sleep(50);
  await useStore.getState().signOut();

  bridge.live.delays.listAgents = 300;
  const before = bridge.calls.filter((c) => c === "listAgents").length;
  const signingIn = useStore.getState().signIn(() => {});
  await sleep(50);
  window.dispatchEvent(new window.Event("focus"));
  window.dispatchEvent(new window.Event("online"));
  await signingIn;
  await sleep(100);
  assert.equal(bridge.calls.filter((c) => c === "listAgents").length - before, 1);
  assert.deepEqual(useStore.getState().agents.map((a) => a.id), [REMOTE_AGENT.id]);
});
