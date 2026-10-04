import { test } from "node:test";
import assert from "node:assert/strict";

import { isDue, localDateKey, parseAt } from "../src/shared/schedule.ts";

const at = (h, m, day = 4) => new Date(2026, 9, day, h, m);
const daily = { at: "06:00", prompt: "Run your daily procedure." };

test("HH:MM parses to minutes; nonsense does not", () => {
  assert.equal(parseAt("06:00"), 360);
  assert.equal(parseAt("6:05"), 365);
  assert.equal(parseAt("23:59"), 1439);
  assert.equal(parseAt("24:00"), null);
  assert.equal(parseAt("06:60"), null);
  assert.equal(parseAt("6am"), null);
});

test("date key is the LOCAL calendar date", () => {
  assert.equal(localDateKey(at(0, 5)), "2026-10-04");
  assert.equal(localDateKey(at(23, 59)), "2026-10-04");
});

test("not due before the slot", () => {
  assert.equal(isDue(daily, at(5, 59), undefined), false);
});

test("due at and after the slot when today has not run", () => {
  assert.equal(isDue(daily, at(6, 0), undefined), true);
  assert.equal(isDue(daily, at(6, 0), "2026-10-03"), true);
});

test("catch-up: Studio opened hours after the slot still fires once", () => {
  assert.equal(isDue(daily, at(14, 30), "2026-10-03"), true);
});

test("never twice a day", () => {
  assert.equal(isDue(daily, at(6, 1), "2026-10-04"), false);
  assert.equal(isDue(daily, at(23, 59), "2026-10-04"), false);
});

test("next day fires again", () => {
  assert.equal(isDue(daily, at(6, 0, 5), "2026-10-04"), true);
});

test("missing, blank or malformed schedules never fire", () => {
  assert.equal(isDue(undefined, at(12, 0), undefined), false);
  assert.equal(isDue({ at: "06:00", prompt: "  " }, at(12, 0), undefined), false);
  assert.equal(isDue({ at: "six", prompt: "x" }, at(12, 0), undefined), false);
});
