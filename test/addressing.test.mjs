import { test } from "node:test";
import assert from "node:assert/strict";
import { addressedIn, recipientsFor } from "../src/shared/addressing.ts";

/**
 * Routing in a room is the difference between asking one agent a question and
 * billing four turns to answer it — and, in the worst case, asking something
 * private in front of everyone. These cases are the ones that decide that.
 */
const members = [
  { id: "a1", name: "Planner" },
  { id: "a2", name: "Designer" },
  { id: "a3", name: "Engineer" },
  { id: "a4", name: "Plan" },
];

test("naming one member addresses only that member", () => {
  const to = recipientsFor("@Designer can you mock this up?", members, "all");
  assert.deepEqual(to, ["a2"]);
});

test("naming two members addresses both, in the order named", () => {
  const { ids } = addressedIn("@Designer and @Engineer — pair on this", members);
  assert.deepEqual(new Set(ids), new Set(["a2", "a3"]));
});

test("a longer name wins over a shorter one contained in it", () => {
  // "Plan" is also a member; "@Planner" must not address it.
  const to = recipientsFor("@Planner what is the status?", members, "all");
  assert.deepEqual(to, ["a1"]);
});

test("@everyone addresses the whole room", () => {
  for (const word of ["@everyone", "@all", "@team"]) {
    assert.deepEqual(recipientsFor(`${word} standup in five`, members, "silent").length, 4, word);
  }
});

test("a bare name is NOT an address", () => {
  // Otherwise an agent called Designer answers every sentence containing the
  // word "designer", and the room becomes a place you tiptoe around.
  const { explicit } = addressedIn("we need a designer view of this", members);
  assert.equal(explicit, false);
});

test("an unaddressed message follows the room's policy", () => {
  const text = "what do we think?";
  assert.deepEqual(recipientsFor(text, members, "all").length, 4);
  assert.deepEqual(recipientsFor(text, members, "lead"), ["a1"]);
  assert.deepEqual(recipientsFor(text, members, "silent"), []);
});

test("an email address does not address anyone", () => {
  const { explicit } = addressedIn("send it to designer@acme.com", members);
  assert.equal(explicit, false, "@ must attach to a member name, not any word");
});

test("case does not matter", () => {
  assert.deepEqual(recipientsFor("@designer look at this", members, "silent"), ["a2"]);
});

test("naming the same member twice addresses them once", () => {
  const { ids } = addressedIn("@Engineer ping @Engineer again", members);
  assert.deepEqual(ids, ["a3"]);
});
