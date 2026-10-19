/**
 * KYB-643: the real renderer store, driven through a fake `window.studio`.
 *
 * Shared by the session-sync tests. Each test FILE gets its own copy of the
 * store, because the store keeps module-level state (listeners attached, the
 * directory gate) that a second scenario in the same process would inherit.
 *
 * Each bridge call can be delayed, which is the whole point: the fault this
 * guards was a race between the directory read and the agent list.
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
for (const name of ["HTMLElement", "Element", "Node", "Event", "CustomEvent", "requestAnimationFrame", "cancelAnimationFrame"]) {
  globalThis[name] = dom.window[name];
}

const realSetTimeout = globalThis.setTimeout;
/** The test's own waits keep the process alive, as they should. */
export const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

// The store's timers do not: the 30 s cross-device tick and a turn's dead-man
// timer would otherwise hold each test file open until the runner kills it.
for (const name of ["setTimeout", "setInterval"]) {
  const real = globalThis[name];
  globalThis[name] = (...args) => {
    const handle = real(...args);
    handle?.unref?.();
    return handle;
  };
}

/** The agent as the control plane lists it: `name` is its registered name. */
export const REMOTE_AGENT = { id: "agent-id", name: "agent", url: "https://agent.example" };

/** A thread the account already has with that agent, from another device. */
export const OLD_THREAD = {
  agent: "agent",
  sessionId: "wrun_OLD",
  label: "agent-id",
  lastMessageAt: "2026-10-10T10:00:00.000Z",
};

/**
 * Install a bridge. `delays` (ms) per method; `hang` methods never answer;
 * `fail` methods reject; `rows` is what the directory holds; `agents` what the
 * control plane grants; `stored` whether a session is already on disk
 * (bootstrap) or a sign-in is needed.
 *
 * `delays`, `rows` and `agents` are read on every call, so a test can change
 * them between sign-ins: `bridge.live.agents = [...]` is another account.
 *
 * `agentSessions`, when given, is what the agent's own `/sessions` lists, and
 * turns on `agentInfo` so `loadAgentInfo` runs (KYB-649); without it the agent
 * reports nothing, as before. `state` is what `conversations.json` holds.
 * Every `resetSession` is recorded in `resets`: nothing may retire a session
 * the test did not mean to.
 */
export function installBridge({
  delays = {},
  hang = [],
  fail = [],
  rows = [OLD_THREAD],
  agents = [REMOTE_AGENT],
  stored = false,
  agentSessions,
  state = null,
} = {}) {
  const calls = [];
  const sends = [];
  const resets = [];
  const live = { rows, agents, agentSessions, state, saved: {}, emit: {} };
  const after = async (name) => {
    calls.push(name);
    // `hang`: never answers, like a control plane that has stopped responding.
    if (hang.includes(name)) await new Promise(() => {});
    if (delays[name]) await sleep(delays[name]);
    if (fail.includes(name)) throw new Error(`${name} failed (test)`);
  };
  const known = {
    session: async () => (stored ? { email: "p@example.com", orgName: "o" } : null),
    signIn: async () => ({ userCode: "CODE", verificationUri: "https://example/verify" }),
    awaitSignIn: async () => ({ email: "p@example.com", orgName: "o" }),
    loadState: async (name) => (name === "conversations.json" ? live.state : null),
    saveState: async ({ name, value }) => {
      live.saved[name] = structuredClone(value);
      return true;
    },
    controlPlane: async () => ({ url: "https://cp.example" }),
    listRooms: async () => [],
    listSessions: async () => {
      await after("listSessions");
      return live.rows;
    },
    listAgents: async () => {
      await after("listAgents");
      return live.agents;
    },
    replaySession: async ({ sessionId }) => {
      await after("replaySession");
      return {
        blocks: [{ eventId: `e-${sessionId}`, role: "agent", text: `history of ${sessionId}`, at: 1 }],
        peerBlocks: [],
        streamIndex: 7,
        truncated: false,
      };
    },
    recordSession: async (entry) => {
      calls.push(`recordSession:${entry.sessionId}`);
    },
    send: async (input) => {
      sends.push(input);
      return { sessionId: input.sessionId ?? "wrun_NEW", streamIndex: 9, reply: "OK" };
    },
    resetSession: async (input) => {
      resets.push(input);
    },
    // The store's stream listeners, so a test can deliver a late event.
    onDelta: (cb) => {
      live.emit.delta = cb;
    },
    onTurn: (cb) => {
      live.emit.turn = cb;
    },
    agentInfo: async () => (live.agentSessions ? { agent: { name: "agent" } } : undefined),
    manage: async ({ path }) => {
      if (live.agentSessions && path.startsWith("/sessions")) {
        return { ok: true, status: 200, data: { sessions: live.agentSessions, routines: null } };
      }
      return { ok: false, status: 404 };
    },
  };
  window.studio = new Proxy(known, {
    get: (target, key) => (key in target ? target[key] : async () => undefined),
  });
  return { calls, sends, resets, live };
}

/** Collect `console.log` lines for the life of one test. */
export function captureLogs(t) {
  const mock = t.mock.method(console, "log", () => {});
  return () => mock.mock.calls.map((c) => c.arguments.map(String).join(" "));
}

/** How many times `text` appears in the agent's chat: a message must be there exactly once. */
export function occurrences(useStore, agentId, text) {
  return (useStore.getState().conversations[agentId] ?? []).filter((b) => b.text === text).length;
}
