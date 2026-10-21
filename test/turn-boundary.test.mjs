import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isHeldForInput } from "../src/main/turnBoundary.ts";

test("eve 0.81: a turn held for a question stops the read; a turn held for tasks does not", () => {
  assert.equal(isHeldForInput("turn.waiting", { on: "input", turnId: "turn_0" }), true);
  assert.equal(isHeldForInput("turn.waiting", { on: "tasks", turnId: "turn_0" }), false);
  assert.equal(isHeldForInput("session.waiting", {}), false);
});

test("a recorded delegation never stops early: its only waits are for tasks", () => {
  const events = readFileSync(new URL("./fixtures/agent-to-agent-tasks.jsonl", import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.type === "turn.waiting"), "the fixture holds the turn");
  assert.equal(events.filter((e) => isHeldForInput(e.type, e.data ?? {})).length, 0);
});
