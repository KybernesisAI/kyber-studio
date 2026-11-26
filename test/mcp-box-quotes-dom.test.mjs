import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge, buttonIn, click, envInput, envLines, form, menu, mount, sealed, type } from "./helpers/mcp-form-dom.mjs";

/**
 * The edit form's box for new values takes one pair of quotes off a value,
 * trims invisible characters, and keeps a key named `__proto__` (KYB-699).
 *
 *  - AC1: `KEY="x"` and `KEY='x'` save `x`.
 *  - AC2: anything that is not one matching pair is kept as typed, and only
 *    one pair is ever taken off.
 *  - AC3: trimmed first, the pair taken off second, and not trimmed again.
 *  - AC4: nothing inside is interpreted: `\n` stays two characters.
 *  - AC5: a stored key's row field is sent exactly as typed, quotes included.
 *  - AC6: `KEY=""` gives an empty value, so KYB-697's rule applies to it.
 *  - AC7: U+FEFF, U+200B, U+200C, U+200D and U+2060 are trimmed at both ends
 *    of the key and the value, and left alone inside.
 *  - AC8: a `__proto__` key, stored or typed in the box, is an own property
 *    of the env the form hands to the bridge. The fake bridge copies with
 *    `structuredClone`, which keeps it. Electron's context bridge copies by
 *    ordinary assignment and drops it, so these tests do not show it reaching
 *    the main process, and in the app it does not.
 *
 * Every value is compared as JSON, so a stray quote, space or zero-width
 * character shows in the failure. No jsdom node is ever the `actual` of an
 * assertion.
 */

const S_API = sealed("sk-live-1");
const S_DB = sealed("postgres://u:p@h/db");
const S_PROTO = sealed("proto-secret");

const NOTE = "API_KEY: Left empty, the stored value is kept. × removes it.";

/** The store available, as the main process answers it (KYB-696). */
const AVAILABLE = () => ({ available: true, description: "", remedy: "" });

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

/** The characters of a string, by code point, for a failure a person can read. */
const codePoints = (s) => [...s].map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`);

async function openEdit(b, name = "Plaud") {
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
  assert.ok(saved.env, "the save sent no env");
  return saved.env;
}

/** Type `lines` in the box of Plaud's edit form, save, and return the env sent. */
async function saveBox(lines, { servers = [plaud()] } = {}) {
  const b = bridge({ answer: AVAILABLE, servers });
  const panel = await openEdit(b);
  try {
    await type(envLines(panel.host), lines);
    return await save(b, panel.host);
  } finally {
    await panel.unmount();
  }
}

/** `NEW_KEY` as sent, checked as an own property and compared character by character. */
async function assertNewKey(lines, expected) {
  const env = await saveBox(lines);
  assert.equal(Object.hasOwn(env, "NEW_KEY"), true, `no NEW_KEY was sent for ${JSON.stringify(lines)}`);
  assert.equal(
    JSON.stringify(env.NEW_KEY),
    JSON.stringify(expected),
    `${JSON.stringify(lines)} saved ${codePoints(env.NEW_KEY).join(" ")}, not ${codePoints(expected).join(" ")}`,
  );
}

// ---- AC1 ---------------------------------------------------------------------

test('AC1: the box line NEW_KEY="secret" saves secret', async () => {
  await assertNewKey('NEW_KEY="secret"', "secret");
});

test("AC1: the box line NEW_KEY='secret' saves secret", async () => {
  await assertNewKey("NEW_KEY='secret'", "secret");
});

// ---- AC2 ---------------------------------------------------------------------

test('AC2: NEW_KEY="abc saves "abc', async () => {
  await assertNewKey('NEW_KEY="abc', '"abc');
});

test('AC2: NEW_KEY=abc" saves abc"', async () => {
  await assertNewKey('NEW_KEY=abc"', 'abc"');
});

test("AC2: NEW_KEY=\"abc' saves \"abc'", async () => {
  await assertNewKey("NEW_KEY=\"abc'", "\"abc'");
});

test('AC2: NEW_KEY=" saves "', async () => {
  await assertNewKey('NEW_KEY="', '"');
});

test('AC2: NEW_KEY="a"b" saves a"b', async () => {
  await assertNewKey('NEW_KEY="a"b"', 'a"b');
});

test('AC2: NEW_KEY=""x"" saves "x", one pair taken off and no more', async () => {
  await assertNewKey('NEW_KEY=""x""', '"x"');
});

// ---- AC3 ---------------------------------------------------------------------

test('AC3: NEW_KEY=  " sp "   saves space, s, p, space', async () => {
  await assertNewKey('NEW_KEY=  " sp "  ', " sp ");
});

// ---- AC4 ---------------------------------------------------------------------

test('AC4: NEW_KEY="a\\nb" saves a, backslash, n, b', async () => {
  await assertNewKey('NEW_KEY="a\\nb"', "a\\nb");
});

// ---- AC5 ---------------------------------------------------------------------

test('AC5: "secret" typed in a stored key\'s row field saves "secret", quotes included', async () => {
  const b = bridge({ answer: AVAILABLE, servers: [plaud()] });
  const panel = await openEdit(b);
  try {
    await type(envInput(panel.host, "API_KEY"), '"secret"');
    const env = await save(b, panel.host);
    assert.equal(JSON.stringify(env.API_KEY), JSON.stringify('"secret"'));
  } finally {
    await panel.unmount();
  }
});

// ---- AC6 ---------------------------------------------------------------------

test('AC6: API_KEY="" over a stored API_KEY saves the original sealed string, with KYB-697\'s note', async () => {
  const b = bridge({ answer: AVAILABLE, servers: [plaud()] });
  const panel = await openEdit(b);
  try {
    await type(envLines(panel.host), 'API_KEY=""');
    assert.deepEqual(boxNotes(panel.host), [NOTE]);
    const env = await save(b, panel.host);
    assert.equal(JSON.stringify(env.API_KEY), JSON.stringify(S_API));
  } finally {
    await panel.unmount();
  }
});

test('AC6: NEW_KEY="" saves an empty value', async () => {
  await assertNewKey('NEW_KEY=""', "");
});

// ---- AC7 ---------------------------------------------------------------------

const INVISIBLE = [
  ["U+FEFF", "\uFEFF"],
  ["U+200B", "\u200B"],
  ["U+200C", "\u200C"],
  ["U+200D", "\u200D"],
  ["U+2060", "\u2060"],
];

for (const [name, c] of INVISIBLE) {
  test(`AC7 (${name}): NEW_KEY= then the character saves an empty value`, async () => {
    await assertNewKey(`NEW_KEY=${c}`, "");
  });

  test(`AC7 (${name}): NEW_KEY= then the character, a, the character saves a`, async () => {
    await assertNewKey(`NEW_KEY=${c}a${c}`, "a");
  });

  test(`AC7 (${name}): the character then NEW_KEY=x saves x under the key NEW_KEY`, async () => {
    const env = await saveBox(`${c}NEW_KEY=x`);
    assert.deepEqual(
      Object.keys(env).map((k) => codePoints(k).join(" ")),
      ["API_KEY", "DB_URL", "NEW_KEY"].map((k) => codePoints(k).join(" ")),
      "the keys sent are not API_KEY, DB_URL and NEW_KEY",
    );
    assert.equal(JSON.stringify(env.NEW_KEY), JSON.stringify("x"));
  });

  test(`AC7 (${name}): NEW_KEY=a, the character, b saves those three characters`, async () => {
    await assertNewKey(`NEW_KEY=a${c}b`, `a${c}b`);
  });
}

// ---- AC8 ---------------------------------------------------------------------

test("AC8: an edit-form save of a server with a stored __proto__ key hands the bridge an env holding __proto__ as an own property with its sealed string", async () => {
  // Built with JSON.parse: a literal `{ __proto__: ... }` sets the prototype
  // and has no such key.
  const env = JSON.parse(JSON.stringify({ API_KEY: S_API }).replace("{", `{"__proto__":${JSON.stringify(S_PROTO)},`));
  assert.equal(Object.hasOwn(env, "__proto__"), true, "precondition: the fixture has no own __proto__");

  const b = bridge({ answer: AVAILABLE, servers: [plaud({ env })] });
  const panel = await openEdit(b);
  try {
    assert.ok(envInput(panel.host, "__proto__"), "precondition: the form shows no row for __proto__");
    const sent = await save(b, panel.host);
    assert.equal(Object.hasOwn(sent, "__proto__"), true, "the env handed to the bridge has no own __proto__");
    assert.equal(JSON.stringify(Object.getOwnPropertyDescriptor(sent, "__proto__")?.value), JSON.stringify(S_PROTO));
    assert.equal(JSON.stringify(sent.API_KEY), JSON.stringify(S_API));
  } finally {
    await panel.unmount();
  }
});

test("AC8: the box line __proto__=x hands the bridge an env holding an own property __proto__ with value x", async () => {
  const sent = await saveBox("__proto__=x");
  assert.equal(Object.hasOwn(sent, "__proto__"), true, "the env handed to the bridge has no own __proto__");
  assert.equal(JSON.stringify(Object.getOwnPropertyDescriptor(sent, "__proto__")?.value), JSON.stringify("x"));
});
