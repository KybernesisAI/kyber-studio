import { test } from "node:test";
import assert from "node:assert/strict";
import { artifactList } from "../src/shared/artifacts.ts";

const A = "a".repeat(32);
const B = "b".repeat(32);

test("the agent's list comes back newest first, in the drawer's shape", () => {
  const list = artifactList({
    ok: true,
    artifacts: [
      { id: A, title: "Website, last 7 days", format: "html", display: "document", version: 3, createdAt: "2026-10-22T09:00:00Z", updatedAt: "2026-10-22T10:00:00Z" },
      { id: B, title: "Notes", format: "markdown", display: "inline", version: 1, createdAt: "2026-10-23T09:00:00Z", updatedAt: "2026-10-23T09:00:00Z" },
    ],
  });
  assert.deepEqual(list.map((a) => a.id), [B, A]);
  assert.equal(list[0].format, "markdown");
  assert.equal(list[1].version, 3);
});

test("rows the viewer would refuse never become rows", () => {
  const list = artifactList({
    artifacts: [
      { id: "../etc", title: "x" },
      { id: "", title: "x" },
      { id: 42, title: "x" },
      null,
      { id: A, title: "  ", format: "pdf", display: "weird", version: -2 },
    ],
  });
  assert.equal(list.length, 1);
  assert.deepEqual(
    { title: list[0].title, format: list[0].format, display: list[0].display, version: list[0].version },
    { title: "Untitled", format: "html", display: "document", version: 1 },
  );
});

test("an answer without a list is an empty list", () => {
  for (const body of [null, {}, { artifacts: "no" }, "text"]) assert.deepEqual(artifactList(body), []);
});
