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
 * A `KEY=` line in the edit form's box for new values no longer destroys a
 * stored value (KYB-697).
 *
 * The box's lines are applied after the stored keys, and `KEY=` used to send
 * an empty value over a stored secret. An empty line for a key still on the
 * form as a stored key is now ignored, and the form says so under the box:
 *
 *  - AC1: `API_KEY=` over a sealed `API_KEY` saves the original sealed string.
 *  - AC2: the box shows "API_KEY: Left empty, the stored value is kept.
 *    × removes it.", and nothing once the line has a value.
 *  - AC3: with a value typed in the row, the note says the typed value is used,
 *    and Save sends it. A revealed value left unchanged is not typed: the note
 *    and Save both keep the stored value.
 *  - AC4: in the warning state the line is ignored too, the note leaves the
 *    clause about × off, and `NEW_KEY=` still sends an empty value.
 *  - AC5: a line with a value still replaces the stored one; `KEY=` for a new
 *    key, or for one removed with ×, still sends `""`, with no note.
 *  - Any box line still hides KYB-693's row note, so the two never stack.
 *
 * The notes under the box are read by their `data-box-note` attribute, and are
 * outside every row, so KYB-693's tests reading `.muted` inside a row do not
 * see them. No jsdom node is ever the `actual` of an assertion.
 */

const NOTE = "API_KEY: Left empty, the stored value is kept. × removes it.";
const NOTE_TYPED = "API_KEY: Left empty, the value typed above is used. × removes it.";
const NOTE_WARN = "API_KEY: Left empty, the stored value is kept.";
const ROW_NOTE = "Left empty, the stored value is kept. × removes it.";

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

/** The notes under the box, in order, as text. */
const boxNotes = (host) => [...form(host).querySelectorAll("[data-box-note]")].map((n) => n.textContent ?? "");
/** How many of the notes under the box sit inside a stored key's row. */
const boxNotesInRows = (host) =>
  [...form(host).querySelectorAll("[data-box-note]")].filter((n) => n.closest(".pl__env")).length;
/** Every message under a stored key's row, in order, as text. */
const messagesOf = (host, key) =>
  [...(envInput(host, key)?.closest(".pl__env")?.querySelectorAll(".muted") ?? [])].map((m) => m.textContent ?? "");

async function openEdit(b, name) {
  const panel = await mount(b.api);
  await menu(panel.host, name, "Edit");
  assert.ok(form(panel.host), "Edit opened no form");
  assert.ok(envLines(panel.host), "precondition: the form offers no box for new values");
  return panel;
}

/** Save, and the env the save sent for the one server. */
async function save(b, host) {
  await click(buttonIn(form(host), "Save"));
  const saved = b.lastSaved()?.[0];
  assert.ok(saved, "nothing was saved");
  return saved.env;
}

/** Open the warning state's edit form: the store unavailable, `API_KEY` stored in plain text. */
async function openWarn() {
  const b = bridge({
    answer: UNAVAILABLE,
    servers: [plaud({ env: { API_KEY: "plain-1" } })],
    reveal: { ok: true, value: "plain-1" },
  });
  const panel = await openEdit(b, "Plaud");
  const said = notices(panel.host);
  assert.equal(said.length, 1, `precondition: the form shows ${said.length} notices, not one warning`);
  assert.match(said[0], /won’t be saved/, "precondition: the notice is not the warning");
  assert.equal(
    Boolean(buttonIn(form(panel.host), "Remove API_KEY")),
    false,
    "precondition: × is offered in the warning state",
  );
  return { b, panel };
}

// ---- AC1 ---------------------------------------------------------------------

test("AC1: an empty box line for a sealed stored key saves the original sealed string", async () => {
  const b = bridge({ answer: AVAILABLE, servers: [plaud()] });
  const panel = await openEdit(b, "Plaud");
  try {
    await type(envLines(panel.host), "API_KEY=");
    assert.deepEqual(await save(b, panel.host), { API_KEY: S_API, DB_URL: S_DB });
  } finally {
    await panel.unmount();
  }
});

// ---- AC2 ---------------------------------------------------------------------

test("AC2: an empty box line for a stored key shows a note under the box, gone once the line has a value", async () => {
  const b = bridge({ answer: AVAILABLE, servers: [plaud()] });
  const panel = await openEdit(b, "Plaud");
  try {
    await type(envLines(panel.host), "API_KEY=");
    assert.deepEqual(boxNotes(panel.host), [NOTE]);
    assert.equal(boxNotesInRows(panel.host), 0, "a note under the box is inside a stored key's row");

    await type(envLines(panel.host), "API_KEY=new");
    assert.deepEqual(boxNotes(panel.host), []);
  } finally {
    await panel.unmount();
  }
});

// ---- AC3 ---------------------------------------------------------------------

test("AC3: with a value typed in the row, the note says the typed value is used, and Save sends it", async () => {
  const b = bridge({ answer: AVAILABLE, servers: [plaud()] });
  const panel = await openEdit(b, "Plaud");
  try {
    await type(envInput(panel.host, "API_KEY"), "new");
    await type(envLines(panel.host), "API_KEY=");
    assert.deepEqual(boxNotes(panel.host), [NOTE_TYPED]);

    const env = await save(b, panel.host);
    assert.equal(env.API_KEY, "new");
  } finally {
    await panel.unmount();
  }
});

test("AC3: a revealed value left unchanged is not typed, so the note says the stored value is kept, and Save sends it sealed", async () => {
  const b = bridge({ answer: AVAILABLE, servers: [plaud()], reveal: { ok: true, value: "sk-live-1" } });
  const panel = await openEdit(b, "Plaud");
  try {
    await click(eyeOf(panel.host, "API_KEY"));
    assert.equal(envInput(panel.host, "API_KEY").value, "sk-live-1", "precondition: the eye did not reveal the value");
    await type(envLines(panel.host), "API_KEY=");
    assert.deepEqual(boxNotes(panel.host), [NOTE]);

    assert.deepEqual(await save(b, panel.host), { API_KEY: S_API, DB_URL: S_DB });
  } finally {
    await panel.unmount();
  }
});

// ---- AC4 ---------------------------------------------------------------------

test("AC4: in the warning state an empty box line for a stored key saves the stored value", async () => {
  const { b, panel } = await openWarn();
  try {
    await type(envLines(panel.host), "API_KEY=");
    assert.deepEqual(await save(b, panel.host), { API_KEY: "plain-1" });
  } finally {
    await panel.unmount();
  }
});

test("AC4: in the warning state the note under the box says the stored value is kept, and nothing about ×", async () => {
  const { panel } = await openWarn();
  try {
    await type(envLines(panel.host), "API_KEY=");
    const said = boxNotes(panel.host);
    assert.deepEqual(said, [NOTE_WARN]);
    assert.equal(said.join("").includes("×"), false, "the note points at ×, which is not offered");
  } finally {
    await panel.unmount();
  }
});

test("AC4: in the warning state an empty box line for a new key still sends an empty value", async () => {
  const { b, panel } = await openWarn();
  try {
    await type(envLines(panel.host), "NEW_KEY=");
    assert.deepEqual(boxNotes(panel.host), [], "a new key's empty line shows a note");
    assert.deepEqual(await save(b, panel.host), { API_KEY: "plain-1", NEW_KEY: "" });
  } finally {
    await panel.unmount();
  }
});

// ---- AC5 ---------------------------------------------------------------------

test("AC5: a box line with a value replaces the stored value", async () => {
  const b = bridge({ answer: AVAILABLE, servers: [plaud()] });
  const panel = await openEdit(b, "Plaud");
  try {
    await type(envLines(panel.host), "API_KEY=new");
    assert.deepEqual(boxNotes(panel.host), [], "a line with a value shows a note");
    assert.deepEqual(await save(b, panel.host), { API_KEY: "new", DB_URL: S_DB });
  } finally {
    await panel.unmount();
  }
});

test("AC5: an empty box line for a key with nothing stored sends an empty value, with no note", async () => {
  const b = bridge({ answer: AVAILABLE, servers: [plaud()] });
  const panel = await openEdit(b, "Plaud");
  try {
    await type(envLines(panel.host), "NEW_KEY=");
    assert.deepEqual(boxNotes(panel.host), []);
    assert.deepEqual(await save(b, panel.host), { API_KEY: S_API, DB_URL: S_DB, NEW_KEY: "" });
  } finally {
    await panel.unmount();
  }
});

test("AC5: × on a stored key and then an empty box line for it sends an empty value, with no note", async () => {
  const b = bridge({ answer: AVAILABLE, servers: [plaud()] });
  const panel = await openEdit(b, "Plaud");
  try {
    await click(buttonIn(form(panel.host), "Remove API_KEY"));
    assert.equal(Boolean(envInput(panel.host, "API_KEY")), false, "precondition: × did not remove API_KEY's row");

    await type(envLines(panel.host), "API_KEY=");
    assert.deepEqual(boxNotes(panel.host), []);
    assert.deepEqual(await save(b, panel.host), { API_KEY: "", DB_URL: S_DB });
  } finally {
    await panel.unmount();
  }
});

// ---- The two notes never stack -----------------------------------------------

test("an emptied row and an empty box line for the same key show one note, under the box", async () => {
  const b = bridge({ answer: AVAILABLE, servers: [plaud()], reveal: { ok: true, value: "sk-live-1" } });
  const panel = await openEdit(b, "Plaud");
  try {
    await click(eyeOf(panel.host, "API_KEY"));
    assert.equal(envInput(panel.host, "API_KEY").value, "sk-live-1", "precondition: the eye did not reveal the value");
    await type(envInput(panel.host, "API_KEY"), "");
    assert.deepEqual(messagesOf(panel.host, "API_KEY"), [ROW_NOTE], "precondition: the emptied row shows no note");

    await type(envLines(panel.host), "API_KEY=");
    assert.deepEqual(messagesOf(panel.host, "API_KEY"), []);
    assert.deepEqual(boxNotes(panel.host), [NOTE]);
  } finally {
    await panel.unmount();
  }
});
