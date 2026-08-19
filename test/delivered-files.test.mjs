import { test } from "node:test";
import assert from "node:assert/strict";
import { deliveredFiles } from "../src/shared/deliveredFiles.ts";

/**
 * A card that offers to save a documentation page is noise, and noise teaches
 * people to ignore cards — including the one that mattered. So the interesting
 * cases here are mostly the things that must NOT be treated as delivered files.
 */

test("a published file becomes a delivered file", () => {
  const [file] = deliveredFiles("Done — the report is at https://files.example.com/q3-report.pdf");
  assert.equal(file.name, "q3-report.pdf");
  assert.equal(file.location, "remote");
  assert.equal(file.extension, "pdf");
});

test("a file written to the user's own machine is found as a local file", () => {
  const [file] = deliveredFiles("I saved it to /Users/sam/Desktop/summary.docx for you.");
  assert.equal(file.name, "summary.docx");
  assert.equal(file.location, "local");
});

test("an ordinary link is not a delivered file", () => {
  // Most URLs in a reply are references, not handovers.
  assert.deepEqual(deliveredFiles("See https://example.com/docs/getting-started for the setup"), []);
  assert.deepEqual(deliveredFiles("The PR is https://github.com/acme/app/pull/12"), []);
});

test("a web page is not a file to keep, even with an extension", () => {
  assert.deepEqual(deliveredFiles("Read https://example.com/report.html"), []);
});

test("an executable or archive is never offered for one-click saving", () => {
  // Nothing should encourage saving something runnable straight out of model
  // output.
  assert.deepEqual(deliveredFiles("Grab https://example.com/tool.dmg"), []);
  assert.deepEqual(deliveredFiles("Grab https://example.com/bundle.zip"), []);
});

test("trailing sentence punctuation is not part of the file name", () => {
  const [file] = deliveredFiles("It is at https://example.com/notes.md.");
  assert.equal(file.raw.endsWith(".md"), true);
  assert.equal(file.name, "notes.md");
});

test("a markdown link yields the file it points at", () => {
  const [file] = deliveredFiles("Here is [the deck](https://example.com/deck.pptx) for tomorrow");
  assert.equal(file.name, "deck.pptx");
});

test("the same file named twice is one file", () => {
  const files = deliveredFiles(
    "Saved /tmp/out.csv. You can open /tmp/out.csv whenever you like.",
  );
  assert.equal(files.length, 1);
});

test("a percent-encoded name is shown the way it reads", () => {
  const [file] = deliveredFiles("https://example.com/Q3%20Board%20Pack.pdf");
  assert.equal(file.name, "Q3 Board Pack.pdf");
});

test("several distinct files in one message are all found", () => {
  const files = deliveredFiles(
    "Two things: https://example.com/a.csv and I also wrote /Users/sam/b.png locally.",
  );
  assert.deepEqual(
    files.map((f) => f.name).sort(),
    ["a.csv", "b.png"],
  );
});

test("a path-looking word inside prose does not become a file", () => {
  assert.deepEqual(deliveredFiles("Use the /api/v1/session endpoint"), []);
});
