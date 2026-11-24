import { test } from "node:test";
import assert from "node:assert/strict";
import { mainProcess, pinPlatform } from "./helpers/mcp-main.mjs";

/**
 * KYB-696 AC5: a stored key removed with × before the availability answer
 * comes back once the answer puts the form in the warning state.
 *
 * For a server with no sealed value, × is offered until the answer arrives,
 * and hidden after it (KYB-695), because while the store is unavailable the
 * main process writes the stored env back unchanged and the removal does
 * nothing. A key removed in that window used to disappear from the form, the
 * warning then said what would and would not be kept, Save sent the removal,
 * main ignored it, and the key was back the next time the form opened.
 *
 * The answer is the main process's real one, held back until the test
 * releases it, so this file means the same thing on the merge base, where the
 * answer is a bare `false` and the key stays gone.
 *
 * A value typed before the answer, for another key or on a new line, is kept
 * and sent: the main process holds it for a server with no sealed value.
 */

pinPlatform("linux");
const main = await mainProcess({ backend: "gnome_libsecret", encryptionAvailable: false });
const dom = await import("./helpers/mcp-form-dom.mjs");

test("AC5: a stored key removed with × before the answer is shown again in the warning state, and Save sends it with what was typed", async () => {
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  const b = dom.bridge({
    answer: () => released.then(() => main.invoke("studio:credentialStoreAvailable")),
    servers: [dom.local({ env: { KYB_KEY: "plain-value", OTHER: "x" } })],
  });
  const panel = await dom.mount(b.api);
  try {
    await dom.menu(panel.host, "MCP kyb", "Edit");
    assert.equal(b.asks(), 1, "precondition: the form did not ask");

    const remove = dom.buttonIn(dom.form(panel.host), "Remove KYB_KEY");
    assert.ok(remove, "precondition: no × on KYB_KEY before the answer");
    await dom.click(remove);
    assert.equal(Boolean(dom.envInput(panel.host, "KYB_KEY")), false, "precondition: × did not remove KYB_KEY");
    await dom.type(dom.envInput(panel.host, "OTHER"), "typed-other");
    await dom.type(dom.envLines(panel.host), "EARLY=typed-early");

    release();
    await dom.flush();

    assert.equal(dom.notices(panel.host).length, 1, "precondition: the answer did not put the form in the warning state");
    assert.match(dom.notices(panel.host)[0], /won’t be saved/, "precondition: the notice is not the warning");
    assert.ok(dom.envInput(panel.host, "KYB_KEY"), "KYB_KEY, removed before the answer, is not shown again");
    assert.equal(Boolean(dom.buttonIn(dom.form(panel.host), "Remove KYB_KEY")), false, "× is offered in the warning state");

    await dom.click(dom.buttonIn(dom.form(panel.host), "Save"));
    const saved = b.lastSaved()?.[0];
    assert.ok(saved, "nothing was saved");
    assert.equal(saved.env?.KYB_KEY, "plain-value", `Save sent the env without KYB_KEY's stored value: ${JSON.stringify(saved.env)}`);
    assert.equal(saved.env?.OTHER, "typed-other", `the value typed for OTHER before the answer was not sent: ${JSON.stringify(saved.env)}`);
    assert.equal(saved.env?.EARLY, "typed-early", `the line typed before the answer was not sent: ${JSON.stringify(saved.env)}`);
    assert.deepEqual(Object.keys(saved.env).sort(), ["EARLY", "KYB_KEY", "OTHER"]);
  } finally {
    await panel.unmount();
  }
});
