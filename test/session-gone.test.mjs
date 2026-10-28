import { test } from "node:test";
import assert from "node:assert/strict";
import { isReplayGone, isSessionStranded, sessionGoneReason } from "../src/shared/sessionGone.ts";

/**
 * KYB-657: which answers to a read of a held conversation mean it no longer
 * exists on the agent. The bodies are eve 0.81.1's own, from its stream route.
 */

test("410 session_expired is gone: the run ended and its history was deleted", () => {
  const body = JSON.stringify({ code: "session_expired", error: "Session history is no longer available.", ok: false });
  assert.equal(sessionGoneReason(410, body), "expired");
});

test("eve's own 404 is gone: it has no run for that id", () => {
  assert.equal(sessionGoneReason(404, JSON.stringify({ error: "Session not found.", ok: false })), "missing");
});

test("a 404 from a hosting platform in front of the agent is not the agent saying the conversation has gone", () => {
  // The answers each platform gives for a deployment that is not there.
  const platforms = {
    "Vercel, plain text": "The deployment could not be found on Vercel.\n\nDEPLOYMENT_NOT_FOUND\n",
    "Vercel, JSON": JSON.stringify({ error: { code: "404", message: "The deployment could not be found on Vercel." } }),
    "Render": "Not Found",
    "Railway": JSON.stringify({ status: "error", code: 404, message: "Application not found" }),
    "a web page": "<!DOCTYPE html><html><body>Not Found</body></html>",
    "no body": "",
  };
  for (const [who, body] of Object.entries(platforms)) {
    assert.equal(sessionGoneReason(404, body), null, who);
  }
});

test("409 session_stranded is not gone: it cannot be followed, but its history can still be read", () => {
  const stranded = JSON.stringify({ code: "session_stranded", error: "This session is no longer available.", ok: false });
  assert.equal(sessionGoneReason(409, stranded), null);
  assert.equal(isSessionStranded(409, stranded), true);
  assert.equal(isSessionStranded(409, "", "session_stranded"), true, "the client's parsed code is enough");
  assert.equal(isSessionStranded(409, JSON.stringify({ code: "session_not_ready" })), false);
  assert.equal(isSessionStranded(409, "not json"), false);
  assert.equal(isSessionStranded(410, stranded), false);
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
