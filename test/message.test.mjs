import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessage } from "../src/shared/message.ts";

/**
 * The shape of a user turn. Two rules here are invisible once written and
 * expensive when broken: an ordinary message must stay a plain string, and the
 * text must precede the files it is about.
 */

const bytes = new Uint8Array([0x68, 0x69]); // "hi"

test("a message with no files stays a plain string", () => {
  // Every turn before attachments existed sent a string. Wrapping those in a
  // one-element array would change the wire format of ordinary messages for no
  // benefit at all.
  assert.equal(buildMessage("what is in flight?"), "what is in flight?");
  assert.equal(buildMessage("what is in flight?", []), "what is in flight?");
});

test("the text comes before the files", () => {
  // A file ahead of its instruction is a document dropped on a desk with no
  // note: the model reads the turn in order, and the request that explains what
  // to do with the file has not arrived yet.
  const content = buildMessage("have a look at this", [
    { name: "brief.pdf", mediaType: "application/pdf", size: 2, bytes },
  ]);
  assert.equal(Array.isArray(content), true);
  assert.equal(content[0].type, "text");
  assert.equal(content[0].text, "have a look at this");
  assert.equal(content[1].type, "file");
});

test("each file becomes one part, in the order it was attached", () => {
  const content = buildMessage("three", [
    { name: "a.pdf", mediaType: "application/pdf", size: 2, bytes },
    { name: "b.png", mediaType: "image/png", size: 2, bytes },
    { name: "c.csv", mediaType: "text/csv", size: 2, bytes },
  ]);
  assert.equal(content.length, 4);
  assert.deepEqual(
    content.slice(1).map((p) => p.filename),
    ["a.pdf", "b.png", "c.csv"],
  );
});

test("the bytes are carried, not a path", () => {
  // A path would mean the agent reaching into the filesystem to fetch the file,
  // which is a different act under different consent.
  const [, file] = buildMessage("here", [
    { name: "note.txt", mediaType: "text/plain", size: 2, bytes },
  ]);
  assert.equal(file.data, "data:text/plain;base64,aGk=");
  assert.equal(file.mediaType, "text/plain");
});

test("a file sent with no words still carries the file", () => {
  // Dragging a document in and pressing enter means "look at this".
  const content = buildMessage("", [
    { name: "brief.pdf", mediaType: "application/pdf", size: 2, bytes },
  ]);
  assert.equal(content[0].text, "");
  assert.equal(content[1].filename, "brief.pdf");
});
