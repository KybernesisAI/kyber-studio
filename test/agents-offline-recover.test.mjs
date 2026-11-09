import { after, test } from "node:test";
import assert from "node:assert/strict";

import { REMOTE_AGENT, installBridge, sleep } from "./fixtures/session-sync-harness.mjs";

/**
 * KYB-669: Studio opened with no network, already signed in.
 *
 * Before the fix the sidebar showed Electron's raw IPC error, and nothing
 * asked for the agent list again: the cross-device refresh ran on every focus
 * and tick, but `syncSessions` returned early ("agents not loaded yet") and
 * the list stayed empty until someone found "Refresh agents".
 */
const RAW = "Error invoking remote method 'studio:listAgents': TypeError: fetch failed";
const bridge = installBridge({ stored: true, fail: ["listAgents"] });
bridge.live.failWith.listAgents = RAW;
const { useStore } = await import("@/lib/store");

after(() => window.close());

const agentCalls = () => bridge.calls.filter((c) => c === "listAgents").length;
const directoryReads = () => bridge.calls.filter((c) => c === "listSessions").length;

test("offline at launch: the sidebar's slot holds a sentence, not the exception", async () => {
  await useStore.getState().bootstrap();
  await sleep(50);
  const s = useStore.getState();
  assert.equal(s.authState, "signed-in");
  assert.deepEqual(s.agents, []);
  assert.equal(s.authError, "Couldn't reach Kybernesis to load your agents. Retrying…");
  assert.doesNotMatch(s.authError, /Error invoking remote method|fetch failed/);
});

test("still offline: each refresh asks for the list again, and the sentence stays", async () => {
  const before = agentCalls();
  window.dispatchEvent(new window.Event("focus"));
  await sleep(50);
  assert.equal(agentCalls(), before + 1, "focus did not ask for the agent list again");
  assert.equal(useStore.getState().agents.length, 0);
  assert.match(useStore.getState().authError, /^Couldn't reach Kybernesis/);
  assert.equal(directoryReads(), 0, "the directory was read against an agent list that never loaded");
});

test("refreshes that arrive together share one request", async () => {
  bridge.live.delays.listAgents = 100;
  const before = agentCalls();
  window.dispatchEvent(new window.Event("focus"));
  window.dispatchEvent(new window.Event("online"));
  window.dispatchEvent(new window.Event("focus"));
  await sleep(250);
  assert.equal(agentCalls(), before + 1, "three refreshes in one moment started more than one listAgents");
  bridge.live.delays.listAgents = 0;
});

test("the network returns: the next refresh loads the list on its own, clears the sentence, and sync resumes", async () => {
  bridge.live.fail = [];
  // `online` is what Chromium fires when the adapter comes back. Focus and the
  // 30 s tick run the same function, so any of the three recovers it.
  window.dispatchEvent(new window.Event("online"));
  await sleep(100);
  const s = useStore.getState();
  assert.deepEqual(s.agents.map((a) => a.id), [REMOTE_AGENT.id]);
  assert.equal(s.authError, null);
  assert.ok(directoryReads() >= 1, "the account's threads were not read once the agents had loaded");
});

test("once loaded, a refresh does not ask for the agent list again", async () => {
  const before = agentCalls();
  window.dispatchEvent(new window.Event("focus"));
  await sleep(50);
  assert.equal(agentCalls(), before, "a loaded list was fetched again on every focus");
});

test("signing out does not carry this sign-in's sentence onto the sign-in screen", async () => {
  bridge.live.fail = ["listAgents"];
  await useStore.getState().refreshAgents();
  assert.match(useStore.getState().authError, /^Couldn't reach Kybernesis/);
  await useStore.getState().signOut();
  assert.equal(useStore.getState().authState, "signed-out");
  assert.equal(useStore.getState().authError, null);
});

test("a failure that lands after sign-out does not put its sentence on the sign-in screen", async () => {
  await useStore.getState().signIn(() => {});
  await sleep(50);
  bridge.live.fail = ["listAgents"];
  bridge.live.delays.listAgents = 150;
  const loading = useStore.getState().refreshAgents();
  await sleep(30);
  await useStore.getState().signOut();
  await loading;
  assert.equal(useStore.getState().authState, "signed-out");
  assert.equal(useStore.getState().authError, null, "a stale failure wrote its sentence after sign-out");
  bridge.live.delays.listAgents = 0;
});
