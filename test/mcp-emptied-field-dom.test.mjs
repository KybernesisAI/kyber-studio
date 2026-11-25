import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bridge,
  buttonIn,
  click,
  envInput,
  envLines,
  eyeOf,
  form,
  menu,
  mount,
  notices,
  sealed,
  type,
} from "./helpers/mcp-form-dom.mjs";

/**
 * A stored key's field emptied in the edit form says the value is kept
 * (KYB-693).
 *
 * Save keeps a stored value whose field is blank: an empty field counts as
 * unchanged, and × is what removes a key. Before this, a field revealed and
 * then emptied, or typed in and then cleared, showed only the dots again,
 * which reads as cleared. The row now says so:
 *
 *  - AC1: an emptied field shows "Left empty, the stored value is kept.
 *    × removes it.", after a reveal and after typing without one.
 *  - AC2: the note follows an edit only: not on a fresh form, not on a field
 *    typed into again, and not after revealing a stored value that is itself
 *    empty. Nor while the box for new values has a line for the key: a line
 *    with a value replaces the stored value on Save, and an empty one is
 *    ignored and has its own note under the box (KYB-697). Nor under the
 *    not-found message, which already says the value is kept.
 *  - AC3: in the warning state, where × is not offered (KYB-695), the note
 *    leaves the clause about × off.
 *  - AC4: Save still sends the original sealed string.
 *
 * The rows are checked for the exact sentence: "stored value is kept" alone is
 * also in the failed-reveal message. No jsdom node is ever the `actual` of an
 * assertion.
 */

const NOTE = "Left empty, the stored value is kept. × removes it.";
const NOTE_WARN = "Left empty, the stored value is kept.";
const NOT_FOUND = "Can’t show it right now. The stored value is kept unless you type a new one or remove it.";

const S_API = sealed("sk-live-1");
const S_DB = sealed("postgres://u:p@h/db");

/** The store available, as the main process answers it (KYB-696). */
const AVAILABLE = () => ({ available: true, description: "", remedy: "" });
const UNAVAILABLE = () => ({ available: false, description: "DESC.", remedy: "REMEDY." });

const plaud = (over = {}) => ({
  id: "plaud",
  name: "Plaud",
  command: "npx",
  args: ["-y", "plaud-mcp"],
  env: { API_KEY: S_API, DB_URL: S_DB },
  enabled: true,
  ...over,
});

const envRow = (host, key) => envInput(host, key)?.closest(".pl__env");
/** Every message under a stored key's row, in order, as text. */
const messagesOf = (host, key) =>
  [...(envRow(host, key)?.querySelectorAll(".muted") ?? [])].map((m) => m.textContent ?? "");
const rowText = (host, key) => envRow(host, key)?.textContent ?? "";

async function openEdit(b, name) {
  const panel = await mount(b.api);
  await menu(panel.host, name, "Edit");
  assert.ok(form(panel.host), "Edit opened no form");
  return panel;
}

// ---- AC1 ---------------------------------------------------------------------

test("AC1: a revealed value emptied from its field says the stored value is kept and × removes it", async () => {
  const b = bridge({ answer: AVAILABLE, servers: [plaud()], reveal: { ok: true, value: "sk-live-1" } });
  const panel = await openEdit(b, "Plaud");
  try {
    await click(eyeOf(panel.host, "API_KEY"));
    assert.equal(envInput(panel.host, "API_KEY").value, "sk-live-1", "precondition: the eye did not reveal the value");
    assert.deepEqual(messagesOf(panel.host, "API_KEY"), [], "precondition: the revealed row already shows a message");

    await type(envInput(panel.host, "API_KEY"), "");
    assert.deepEqual(messagesOf(panel.host, "API_KEY"), [NOTE]);
    assert.deepEqual(messagesOf(panel.host, "DB_URL"), [], "a row that was not touched shows a message");
  } finally {
    await panel.unmount();
  }
});

test("AC1: a value typed without a reveal and then deleted says the stored value is kept and × removes it", async () => {
  const b = bridge({ answer: AVAILABLE, servers: [plaud()] });
  const panel = await openEdit(b, "Plaud");
  try {
    await type(envInput(panel.host, "API_KEY"), "x");
    await type(envInput(panel.host, "API_KEY"), "");
    assert.deepEqual(messagesOf(panel.host, "API_KEY"), [NOTE]);
  } finally {
    await panel.unmount();
  }
});

// ---- AC2 ---------------------------------------------------------------------

test("AC2: a freshly opened form shows no note on any row", async () => {
  const b = bridge({ answer: AVAILABLE, servers: [plaud()] });
  const panel = await openEdit(b, "Plaud");
  try {
    for (const key of ["API_KEY", "DB_URL"]) {
      assert.equal(envInput(panel.host, key).value, "", `precondition: ${key}'s field is not empty`);
      assert.deepEqual(messagesOf(panel.host, key), [], `${key}'s row shows a message on a fresh form`);
    }
  } finally {
    await panel.unmount();
  }
});

test("AC2: a field emptied and then typed into again shows no note", async () => {
  const b = bridge({ answer: AVAILABLE, servers: [plaud()] });
  const panel = await openEdit(b, "Plaud");
  try {
    await type(envInput(panel.host, "API_KEY"), "x");
    assert.deepEqual(messagesOf(panel.host, "API_KEY"), [], "a field holding a typed value shows a message");
    await type(envInput(panel.host, "API_KEY"), "");
    assert.equal(envInput(panel.host, "API_KEY").value, "", "precondition: the field was not emptied");

    await type(envInput(panel.host, "API_KEY"), "y");
    assert.deepEqual(messagesOf(panel.host, "API_KEY"), []);
  } finally {
    await panel.unmount();
  }
});

test("AC2: revealing a stored value that is itself empty shows no note", async () => {
  const b = bridge({
    answer: AVAILABLE,
    servers: [plaud({ env: { API_KEY: sealed("") } })],
    reveal: { ok: true, value: "" },
  });
  const panel = await openEdit(b, "Plaud");
  try {
    await click(eyeOf(panel.host, "API_KEY"));
    assert.equal(envInput(panel.host, "API_KEY").type, "text", "precondition: the eye did not reveal the value");
    assert.equal(envInput(panel.host, "API_KEY").value, "", "precondition: the revealed field is not empty");
    assert.deepEqual(messagesOf(panel.host, "API_KEY"), []);
  } finally {
    await panel.unmount();
  }
});

/** Empty API_KEY's field after a reveal, as AC1 does. */
async function emptyApiKey(panel) {
  await click(eyeOf(panel.host, "API_KEY"));
  assert.equal(envInput(panel.host, "API_KEY").value, "sk-live-1", "precondition: the eye did not reveal the value");
  await type(envInput(panel.host, "API_KEY"), "");
}

test("AC2: an emptied field shows no note while the box has a line with a value for its key", async () => {
  const b = bridge({ answer: AVAILABLE, servers: [plaud()], reveal: { ok: true, value: "sk-live-1" } });
  const panel = await openEdit(b, "Plaud");
  try {
    await emptyApiKey(panel);
    assert.ok(envLines(panel.host), "precondition: the form offers no box for new values");

    await type(envLines(panel.host), "API_KEY=new");
    assert.equal(envInput(panel.host, "API_KEY").value, "", "precondition: the field is no longer empty");
    assert.deepEqual(messagesOf(panel.host, "API_KEY"), []);

    await type(envLines(panel.host), "");
    assert.deepEqual(messagesOf(panel.host, "API_KEY"), [NOTE], "the note did not come back when the box was cleared");
  } finally {
    await panel.unmount();
  }
});

test("AC2: an emptied field shows no note while the box has an empty line for its key", async () => {
  const b = bridge({ answer: AVAILABLE, servers: [plaud()], reveal: { ok: true, value: "sk-live-1" } });
  const panel = await openEdit(b, "Plaud");
  try {
    await emptyApiKey(panel);
    assert.ok(envLines(panel.host), "precondition: the form offers no box for new values");

    await type(envLines(panel.host), "API_KEY=");
    assert.equal(envInput(panel.host, "API_KEY").value, "", "precondition: the field is no longer empty");
    assert.deepEqual(messagesOf(panel.host, "API_KEY"), []);
  } finally {
    await panel.unmount();
  }
});

test("AC2: an emptied field under the not-found message shows that message and no note", async () => {
  const b = bridge({ answer: AVAILABLE, servers: [plaud()], reveal: { ok: false, reason: "not-found" } });
  const panel = await openEdit(b, "Plaud");
  try {
    await click(eyeOf(panel.host, "API_KEY"));
    assert.deepEqual(messagesOf(panel.host, "API_KEY"), [NOT_FOUND], "precondition: the row does not show the not-found message");

    await type(envInput(panel.host, "API_KEY"), "x");
    await type(envInput(panel.host, "API_KEY"), "");
    assert.equal(envInput(panel.host, "API_KEY").value, "", "precondition: the field was not emptied");
    assert.deepEqual(messagesOf(panel.host, "API_KEY"), [NOT_FOUND]);
  } finally {
    await panel.unmount();
  }
});

// ---- AC3 ---------------------------------------------------------------------

test("AC3: in the warning state an emptied field says the stored value is kept, and nothing about ×", async () => {
  const b = bridge({
    answer: UNAVAILABLE,
    servers: [plaud({ env: { API_KEY: "plain-1" } })],
    reveal: { ok: true, value: "plain-1" },
  });
  const panel = await openEdit(b, "Plaud");
  try {
    const said = notices(panel.host);
    assert.equal(said.length, 1, `precondition: the form shows ${said.length} notices, not one warning`);
    assert.match(said[0], /won’t be saved/, "precondition: the notice is not the warning");
    assert.equal(
      Boolean(buttonIn(form(panel.host), "Remove API_KEY")),
      false,
      "precondition: × is offered in the warning state",
    );

    await click(eyeOf(panel.host, "API_KEY"));
    assert.equal(envInput(panel.host, "API_KEY").value, "plain-1", "precondition: the eye did not reveal the value");
    await type(envInput(panel.host, "API_KEY"), "");

    assert.deepEqual(messagesOf(panel.host, "API_KEY"), [NOTE_WARN]);
    assert.equal(rowText(panel.host, "API_KEY").includes("×"), false, "the row points at ×, which is not offered");
  } finally {
    await panel.unmount();
  }
});

// ---- AC4 ---------------------------------------------------------------------

test("AC4: saving emptied fields sends the original sealed strings", async () => {
  const b = bridge({ answer: AVAILABLE, servers: [plaud()], reveal: { ok: true, value: "sk-live-1" } });
  const panel = await openEdit(b, "Plaud");
  try {
    await click(eyeOf(panel.host, "API_KEY"));
    await type(envInput(panel.host, "API_KEY"), "");
    await type(envInput(panel.host, "DB_URL"), "x");
    await type(envInput(panel.host, "DB_URL"), "");
    assert.equal(envInput(panel.host, "API_KEY").type, "text", "precondition: API_KEY was not revealed");
    for (const key of ["API_KEY", "DB_URL"]) {
      assert.equal(envInput(panel.host, key).value, "", `precondition: ${key}'s field was not emptied`);
    }

    await click(buttonIn(form(panel.host), "Save"));
    const saved = b.lastSaved()?.[0];
    assert.ok(saved, "nothing was saved");
    assert.deepEqual(saved.env, { API_KEY: S_API, DB_URL: S_DB });
  } finally {
    await panel.unmount();
  }
});
