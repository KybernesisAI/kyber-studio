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
 * A real Kyber→Sid exchange, recorded from production on 2026-08-14.
 *
 * Every shape in the reader was wrong at least once before this fixture
 * existed: the answer is not a string, its call id is not where the other
 * events put theirs, and a remote peer's result is indistinguishable from a
 * local subagent's except by that id. Guessing was the bug; this is the answer
 * key.
 */
function fixture() {
  return readFileSync(join(here, "fixtures/a2a-kyber-sid.jsonl"), "utf8")
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
  assert.equal(seen[0].peer, "sid");
  assert.equal(seen[0].text, "Identify yourself in one sentence.");
  assert.equal(seen[1].peer, "sid");
  assert.match(seen[1].text, /I'm Sid, Ian's personal chief of staff/);
});

test("nothing is left pending after the peer answers", () => {
  const { state } = replay(fixture());
  assert.equal(state.pending.size, 0);
  assert.equal(state.last, null);
});

test("a local subagent finishing is not the remote peer answering", () => {
  // The failure this prevents: Kyber has three local subagents beside two
  // remote peers. Attributing by "the last peer we called" captions a local
  // delegation as a message from Sid.
  const state = { pending: new Map(), last: null };
  readPeerEvents(
    "actions.requested",
    { actions: [{ kind: "remote-agent-call", name: "sid", callId: "call_remote", input: { message: "hi" } }] },
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
        { kind: "remote-agent-call", name: "sid", callId: "c1", input: { message: "ask sid" } },
        { kind: "remote-agent-call", name: "eve-gtm", callId: "c2", input: { message: "ask gtm" } },
      ],
    },
    state,
  );

  const second = readPeerEvents("action.result", { result: { callId: "c2", output: "gtm says hello" } }, state);
  const first = readPeerEvents("action.result", { result: { callId: "c1", output: "sid says hello" } }, state);

  assert.equal(second[0].peer, "eve-gtm", "answers are matched by id, not by arrival order");
  assert.equal(first[0].peer, "sid");
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
