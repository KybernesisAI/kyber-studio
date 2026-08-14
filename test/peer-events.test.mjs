import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The reader is plain TypeScript with no Electron imports, so node --test can
// load it directly under --experimental-strip-types.
import { readPeerEvents } from "../src/main/peerEvents.ts";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * A real exchange between two deployed agents, recorded from a live run.
 *
 * Every shape in the reader was wrong at least once before this fixture
 * existed: the answer is not a string, its call id is not where the other
 * events put theirs, and a remote peer's result is indistinguishable from a
 * local subagent's except by that id. Guessing was the bug; this is the answer
 * key.
 */
function fixture() {
  return readFileSync(join(here, "fixtures/agent-to-agent.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function replay(events) {
  const state = { pending: new Map(), last: null };
  const seen = [];
  for (const e of events) {
    for (const p of readPeerEvents(e.type, e.data ?? {}, state)) seen.push(p);
  }
  return { seen, state };
}

test("a real hop yields the question and the answer, in order", () => {
  const { seen } = replay(fixture());

  assert.equal(seen.length, 2, "one outbound, one inbound");
  assert.deepEqual(
    seen.map((p) => p.direction),
    ["outbound", "inbound"],
  );
  assert.equal(seen[0].peer, "specialist");
  assert.equal(seen[0].text, "Identify yourself in one sentence.");
  assert.equal(seen[1].peer, "specialist");
  assert.match(seen[1].text, /scheduling specialist/);
});

test("nothing is left pending after the peer answers", () => {
  const { state } = replay(fixture());
  assert.equal(state.pending.size, 0);
  assert.equal(state.last, null);
});

test("a local subagent finishing is not the remote peer answering", () => {
  // The failure this prevents: an agent with local subagents alongside remote
  // peers. Attributing by "the last peer we called" captions a local
  // delegation as a message from the remote agent.
  const state = { pending: new Map(), last: null };
  readPeerEvents(
    "actions.requested",
    { actions: [{ kind: "remote-agent-call", name: "specialist", callId: "call_remote", input: { message: "hi" } }] },
    state,
  );
  const stray = readPeerEvents(
    "action.result",
    { result: { callId: "call_local", kind: "subagent-result", output: "engineering finished", subagentName: "engineering" } },
    state,
  );

  assert.deepEqual(stray, [], "an unrelated call id must produce nothing");
  assert.equal(state.pending.size, 1, "the real peer call is still outstanding");
});

test("two peers in flight each get their own answer", () => {
  const state = { pending: new Map(), last: null };
  readPeerEvents(
    "actions.requested",
    {
      actions: [
        { kind: "remote-agent-call", name: "specialist", callId: "c1", input: { message: "ask specialist" } },
        { kind: "remote-agent-call", name: "research", callId: "c2", input: { message: "ask gtm" } },
      ],
    },
    state,
  );

  const second = readPeerEvents("action.result", { result: { callId: "c2", output: "gtm says hello" } }, state);
  const first = readPeerEvents("action.result", { result: { callId: "c1", output: "specialist says hello" } }, state);

  assert.equal(second[0].peer, "research", "answers are matched by id, not by arrival order");
  assert.equal(first[0].peer, "specialist");
});

test("ordinary tool calls are ignored entirely", () => {
  const state = { pending: new Map(), last: null };
  const out = readPeerEvents(
    "actions.requested",
    { actions: [{ kind: "tool-call", toolName: "local_read", input: { path: "/tmp/x" } }] },
    state,
  );
  assert.deepEqual(out, []);
  assert.equal(state.pending.size, 0);
});
