import { test } from "node:test";
import assert from "node:assert/strict";

import { agentsLoadError, isNotSignedIn } from "@/lib/agentsLoadError";

/**
 * KYB-669: what the sidebar says when the agent list could not be loaded.
 *
 * The inputs are the strings the renderer actually receives: Electron wraps
 * whatever `listAgents` in the main process threw as
 * `Error invoking remote method 'studio:listAgents': <Name>: <message>`.
 */
const ipc = (inner) => new Error(`Error invoking remote method 'studio:listAgents': ${inner}`);

const NETWORK = "Couldn't reach Kybernesis to load your agents. Retrying…";

for (const [label, error] of [
  ["no network (measured in the KYB-608 UAT)", ipc("TypeError: fetch failed")],
  ["the 20 s fetch timeout", ipc("TimeoutError: The operation was aborted due to timeout")],
  ["unwrapped, as a test bridge or a future caller might throw it", new TypeError("fetch failed")],
  ["not an Error at all", "fetch failed"],
  ["a captive portal answering 200 with HTML", ipc("SyntaxError: Unexpected token '<', \"<!doctype \"... is not valid JSON")],
]) {
  test(`network failure says so in words: ${label}`, () => {
    assert.equal(agentsLoadError(error), NETWORK);
  });
}

const EXPIRED = "Your sign-in has expired. Sign out from the account menu, then sign in again.";

test("an expired session is named as one, and does not promise a retry that cannot help", () => {
  assert.equal(agentsLoadError(ipc("Error: Session expired. Sign in again.")), EXPIRED);
});

test("'Not signed in.' with the session still stored is the network, not a sign-out", () => {
  // Offline, more than an hour after the last refresh: the token is expired,
  // the refresh cannot reach the network, and activeSession answers null.
  const error = ipc("Error: Not signed in.");
  assert.equal(isNotSignedIn(error), true);
  assert.equal(agentsLoadError(error, { sessionStored: true }), NETWORK);
  assert.equal(agentsLoadError(error), NETWORK, "the default must not claim a sign-out nobody measured");
});

test("'Not signed in.' with the session dropped is a real sign-out", () => {
  // A refresh answered 401 or 403, and the main process cleared the session.
  assert.equal(agentsLoadError(ipc("Error: Not signed in."), { sessionStored: false }), EXPIRED);
});

test("only 'Not signed in.' consults the stored session", () => {
  assert.equal(isNotSignedIn(ipc("TypeError: fetch failed")), false);
  assert.equal(agentsLoadError(ipc("TypeError: fetch failed"), { sessionStored: false }), NETWORK);
});

test("a control plane that answered with an error status says which, and that it is retrying", () => {
  assert.equal(
    agentsLoadError(ipc("Error: Could not list agents (HTTP 503).")),
    "Kybernesis could not load your agents (HTTP 503). Retrying…",
  );
});

test("nothing it returns carries the raw exception (AC1's failure condition)", () => {
  for (const error of [
    ipc("TypeError: fetch failed"),
    ipc("Error: Session expired. Sign in again."),
    ipc("Error: Could not list agents (HTTP 500)."),
    ipc("Error: something nobody anticipated"),
  ]) {
    const said = agentsLoadError(error);
    assert.doesNotMatch(said, /Error invoking remote method|fetch failed|studio:listAgents/);
  }
});
