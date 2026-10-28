import { test } from "node:test";
import assert from "node:assert/strict";
import { isReplayGone, sessionGoneReason } from "../src/shared/sessionGone.ts";

/**
 * KYB-657: which answers to a read of a held conversation mean it no longer
 * exists on the agent. The bodies are eve 0.81.1's own, from its stream route.
 */

test("410 session_expired is gone: the run ended and its history was deleted", () => {
  const body = JSON.stringify({ code: "session_expired", error: "Session history is no longer available.", ok: false });
  assert.equal(sessionGoneReason(410, body), "expired");
});

test("404 is gone: eve has no run for that id", () => {
  assert.equal(sessionGoneReason(404, JSON.stringify({ error: "Session not found.", ok: false })), "missing");
});

test("409 is gone only when the session is stranded", () => {
  const stranded = JSON.stringify({ code: "session_stranded", error: "This session is no longer available.", ok: false });
  assert.equal(sessionGoneReason(409, stranded), "stranded");
  assert.equal(sessionGoneReason(409, "", "session_stranded"), "stranded", "the client's parsed code is enough");
  assert.equal(sessionGoneReason(409, JSON.stringify({ code: "session_not_ready" })), null);
  assert.equal(sessionGoneReason(409, "not json"), null);
});

test("an agent that is down, restarting or refusing the sign-in has not lost the conversation", () => {
  for (const status of [401, 403, 500, 502, 503, 504]) {
    assert.equal(sessionGoneReason(status, ""), null, `HTTP ${status}`);
  }
});

test("a gone read is told apart from a transcript and from no answer", () => {
  assert.equal(isReplayGone({ gone: "expired" }), true);
  assert.equal(isReplayGone(null), false);
  assert.equal(isReplayGone({ blocks: [], peerBlocks: [], streamIndex: 0, truncated: false }), false);
});
