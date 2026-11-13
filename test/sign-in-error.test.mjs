import { test } from "node:test";
import assert from "node:assert/strict";

import { DENIED, EXPIRED, OFFLINE, UNFINISHED, signInError } from "@/lib/signInError";

/**
 * KYB-679: what the sign-in screen says when a sign-in does not finish.
 *
 * The inputs are the strings the renderer receives. Electron wraps whatever the
 * `studio:signIn` or `studio:awaitSignIn` handler threw as
 * `Error invoking remote method '<channel>': <Name>: <message>`, and the
 * main-process messages below are the ones `startDeviceAuth`,
 * `pollDeviceAuth` and the handlers in `src/main` throw today.
 */
const awaiting = (inner) => new Error(`Error invoking remote method 'studio:awaitSignIn': ${inner}`);
const starting = (inner) => new Error(`Error invoking remote method 'studio:signIn': ${inner}`);
const RAW = /Error invoking remote method|studio:|expired_token|access_denied|invalid_grant|TypeError|SyntaxError/;

test("the string measured in the KYB-632 UAT reads as an expired code", () => {
  const shown = signInError(awaiting("Error: Sign-in failed: expired_token"));
  assert.equal(shown, EXPIRED);
  assert.doesNotMatch(shown, RAW);
});

test("the client's own deadline says the same as the server's expiry", () => {
  // Which arrives first depends on the server's expiry, so the person must not
  // be told two different things about one event.
  assert.equal(signInError(awaiting("Error: Sign-in timed out. Start again and approve the code in your browser.")), EXPIRED);
});

test("a code declined in the browser is named as declined", () => {
  assert.equal(signInError(awaiting("Error: Sign-in failed: access_denied")), DENIED);
});

test("any other slug from the control plane shows a sentence, not the slug", () => {
  const shown = signInError(awaiting("Error: Sign-in failed: invalid_grant"));
  assert.equal(shown, UNFINISHED);
  assert.doesNotMatch(shown, RAW);
});

for (const [label, error] of [
  ["no network while starting", starting("TypeError: fetch failed")],
  ["no network while waiting", awaiting("TypeError: fetch failed")],
  ["the 20 s fetch timeout", awaiting("TimeoutError: The operation was aborted due to timeout")],
  ["a captive portal answering 200 with HTML", starting(`SyntaxError: Unexpected token '<', "<html>" is not valid JSON`)],
  ["a 2xx reply with an empty body", starting("SyntaxError: Unexpected end of JSON input")],
]) {
  test(`the network says so in words: ${label}`, () => {
    assert.equal(signInError(error), OFFLINE);
  });
}

test("a sentence the main process already wrote is shown without the wrapper", () => {
  const inner = "Control plane refused the device request (HTTP 503) at https://cp.example.";
  assert.equal(signInError(starting(`Error: ${inner}`)), inner);
  assert.equal(signInError(awaiting("Error: No sign-in in progress.")), "No sign-in in progress.");
});

test("a cancelled sign-in shows nothing", () => {
  assert.equal(signInError(awaiting("Error: sign-in cancelled")), null);
  assert.equal(signInError(new Error("sign-in cancelled")), null);
});

test("an empty or unwrapped failure still gives a sentence", () => {
  assert.equal(signInError(new Error("")), UNFINISHED);
  assert.equal(signInError(awaiting("Error: ")), UNFINISHED);
  assert.equal(signInError("Sign-in failed: expired_token"), EXPIRED);
});
