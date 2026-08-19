import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  formatSize,
  mediaTypeFor,
  readFiles,
} from "../src/renderer/src/lib/attachments.ts";

/**
 * What a person attaches has to arrive whole or be refused in words they can
 * act on. The silent failures are the expensive ones: a file that vanishes
 * between the drop and the send looks like the agent ignoring it, and a file
 * quietly truncated looks like the agent misreading it.
 */

/** A stand-in for the browser's File, which node does not have. */
function fakeFile(name, size, type = "") {
  return {
    name,
    size,
    type,
    arrayBuffer: async () => new ArrayBuffer(size),
  };
}

test("a file is read through with its name, type and size intact", async () => {
  const { accepted, rejected } = await readFiles([fakeFile("brief.pdf", 1024, "application/pdf")]);
  assert.equal(rejected.length, 0);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].name, "brief.pdf");
  assert.equal(accepted[0].mediaType, "application/pdf");
  assert.equal(accepted[0].size, 1024);
  assert.equal(accepted[0].bytes.byteLength, 1024);
});

test("a media type is guessed from the extension when the browser gives none", async () => {
  // Files dragged from some applications arrive with an empty type, and a model
  // cannot decode bytes it has no type for.
  assert.equal(mediaTypeFor({ name: "notes.md", type: "" }), "text/markdown");
  assert.equal(mediaTypeFor({ name: "shot.PNG", type: "" }), "image/png");
  assert.equal(mediaTypeFor({ name: "report.docx", type: "" }).includes("wordprocessingml"), true);
});

test("an unknown extension falls back to binary rather than to a plausible guess", async () => {
  // A wrong specific type makes a model try to decode something it cannot,
  // which surfaces as the file appearing corrupt.
  assert.equal(mediaTypeFor({ name: "archive.qqq", type: "" }), "application/octet-stream");
});

test("the browser's own type wins over the extension", async () => {
  assert.equal(mediaTypeFor({ name: "data.txt", type: "application/pdf" }), "application/pdf");
});

test("an oversized file is refused, and the message names it and the limit", async () => {
  const { accepted, rejected } = await readFiles([fakeFile("huge.zip", MAX_FILE_BYTES + 1)]);
  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0], /huge\.zip/);
  assert.match(rejected[0], /limit/);
});

test("one bad file does not take the good ones with it", async () => {
  const { accepted, rejected } = await readFiles([
    fakeFile("ok-one.pdf", 500, "application/pdf"),
    fakeFile("huge.zip", MAX_FILE_BYTES + 1),
    fakeFile("ok-two.png", 700, "image/png"),
  ]);
  assert.deepEqual(
    accepted.map((f) => f.name),
    ["ok-one.pdf", "ok-two.png"],
  );
  assert.equal(rejected.length, 1);
});

test("the total limit counts what is already attached, not just this drop", async () => {
  // Five files dropped one at a time must be refused at the same point five
  // dropped together would be.
  const already = [{ id: "a", name: "big.bin", mediaType: "application/octet-stream", size: MAX_TOTAL_BYTES - 100, bytes: new Uint8Array(0) }];
  const { accepted, rejected } = await readFiles([fakeFile("last.pdf", 500)], already);
  assert.equal(accepted.length, 0);
  assert.match(rejected[0], /separately/);
});

test("a folder, which arrives as a zero-byte entry, is refused in those words", async () => {
  const { accepted, rejected } = await readFiles([fakeFile("Documents", 0)]);
  assert.equal(accepted.length, 0);
  assert.match(rejected[0], /folder/);
});

test("a file that cannot be read is refused rather than attached empty", async () => {
  const unreadable = {
    name: "gone.pdf",
    size: 10,
    type: "application/pdf",
    arrayBuffer: async () => {
      throw new Error("no such file");
    },
  };
  const { accepted, rejected } = await readFiles([unreadable]);
  assert.equal(accepted.length, 0);
  assert.match(rejected[0], /gone\.pdf/);
  assert.match(rejected[0], /no such file/);
});

test("every accepted file gets its own id, so removing one chip removes one file", async () => {
  const { accepted } = await readFiles([
    fakeFile("same.pdf", 100, "application/pdf"),
    fakeFile("same.pdf", 100, "application/pdf"),
  ]);
  assert.equal(accepted.length, 2);
  assert.notEqual(accepted[0].id, accepted[1].id);
});

test("sizes read the way a person would say them", () => {
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(2048), "2 KB");
  assert.equal(formatSize(5 * 1024 * 1024), "5.0 MB");
});
