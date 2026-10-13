import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * KYB-631: what a failed transcription says to the person who asked for it.
 *
 * The defect was one `catch` handing the renderer `(error as Error).message`
 * raw. On a Windows machine whose MSVC runtime predates the toolset
 * `onnxruntime` was built with, that message is the Win32 string for
 * ERROR_DLL_INIT_FAILED — localised, unactionable, and carrying the absolute
 * path of the binding including the user's own account name.
 *
 * Two things therefore need demonstrating rather than asserting, and they pull
 * in opposite directions:
 *
 * 1. the binding failure DOES map to the guidance, including when the message
 *    is in a language nobody here reads; and
 * 2. nothing else does, and no other platform does.
 *
 * A check that rewrote every error into "install the redistributable" would
 * pass (1) and be worse than the defect, so most of this file is (2).
 */

const dir = mkdtempSync(join(tmpdir(), "kyb-dictation-"));

// No models under this root, which is what makes `dictationAvailable()` false
// for the discrimination test at the bottom.
mock.module("electron", {
  exports: {
    app: {
      getPath: () => dir,
      getAppPath: () => dir,
    },
  },
});

const { dictationErrorMessage, transcribe } = await import("../src/main/dictation.ts");

/** The real thing, verbatim from a Windows 11 machine, account name redacted. */
const WIN32_DLL_INIT =
  "A dynamic link library (DLL) initialization routine failed. " +
  "\\\\?\\C:\\Users\\pholder\\AppData\\Local\\Programs\\KYBER Studio\\resources\\" +
  "app.asar.unpacked\\node_modules\\onnxruntime-node\\bin\\napi-v6\\win32\\x64\\onnxruntime_binding.node";

/** The same failure on a German machine. The code is identical; the prose is not. */
const WIN32_DLL_INIT_DE =
  "Eine Initialisierungsroutine der Dynamic Link Library (DLL) ist fehlgeschlagen. " +
  "\\\\?\\C:\\Users\\pholder\\AppData\\Local\\Programs\\KYBER Studio\\resources\\app.asar.unpacked\\x64\\binding.node";

function dlopenError(message) {
  const error = new Error(message);
  error.code = "ERR_DLOPEN_FAILED";
  return error;
}

test("the binding failure becomes guidance a person can act on", () => {
  const message = dictationErrorMessage(dlopenError(WIN32_DLL_INIT), "win32");

  assert.match(message, /Microsoft Visual C\+\+ 2015-2022 x64 Redistributable/);
  assert.match(message, /14\.44 or newer/);
});

test("detection does not depend on the message being in English", () => {
  // The whole point of keying on `code`. If this ever fails, the check has
  // started reading the prose and a German machine gets the raw string back.
  assert.equal(
    dictationErrorMessage(dlopenError(WIN32_DLL_INIT_DE), "win32"),
    dictationErrorMessage(dlopenError(WIN32_DLL_INIT), "win32")
  );
});

test("nothing identifying reaches the message", () => {
  const message = dictationErrorMessage(dlopenError(WIN32_DLL_INIT), "win32");

  assert.ok(!message.includes("pholder"), "the account name must not survive");
  assert.ok(!/[A-Za-z]:\\/.test(message), `a Windows path survived: ${message}`);
  assert.ok(!message.includes("\\\\?\\"), "an extended-length path prefix survived");
  assert.ok(!message.includes(".node"), "the binding filename survived");
  assert.ok(!message.includes("app.asar"), "an internal layout detail survived");
});

test("a wrapped failure is still recognised, however deep", () => {
  const inner = dlopenError(WIN32_DLL_INIT);
  const middle = new Error("failed to construct the pipeline", { cause: inner });
  const outer = new Error("dictation unavailable", { cause: middle });

  assert.match(dictationErrorMessage(outer, "win32"), /Redistributable/);
});

test("the binding's own filename is enough, for the day something strips the code", () => {
  const stripped = new Error(WIN32_DLL_INIT); // no `code` at all
  assert.match(dictationErrorMessage(stripped, "win32"), /Redistributable/);
});

test("an unrelated Windows failure keeps its own message", () => {
  // The discrimination that matters. A handler that cannot tell these apart
  // would send somebody to install a runtime they already have.
  assert.equal(dictationErrorMessage(new Error("Nothing was recorded."), "win32"), "Nothing was recorded.");
  assert.equal(dictationErrorMessage(new Error("out of memory"), "win32"), "out of memory");

  const enoent = new Error("ENOENT: no such file or directory, open 'config.json'");
  enoent.code = "ENOENT";
  assert.equal(dictationErrorMessage(enoent, "win32"), enoent.message);
});

test("non-Windows platforms are unaffected", () => {
  // Same error object, every platform. The redistributable does not exist to
  // install on these, so the guidance would be actively misleading.
  for (const platform of ["linux", "darwin", "freebsd"]) {
    assert.equal(dictationErrorMessage(dlopenError(WIN32_DLL_INIT), platform), WIN32_DLL_INIT);
  }
});

test("a thrown non-Error is stringified rather than crashing the handler", () => {
  assert.equal(dictationErrorMessage("just a string", "win32"), "just a string");
  assert.equal(dictationErrorMessage(undefined, "win32"), "undefined");
  assert.equal(dictationErrorMessage({ nope: true }, "win32"), "[object Object]");
});

test("a cyclic cause chain terminates", () => {
  // Not hypothetical politeness: `cause` is caller-supplied, and an unbounded
  // walk would hang the main process on the one path that is already failing.
  const a = new Error("a");
  const b = new Error("b", { cause: a });
  a.cause = b;

  assert.equal(dictationErrorMessage(a, "win32"), "a");
});

test("transcribe() still answers its own failures in its own words", async () => {
  // Through the real function rather than the classifier, so the wiring is
  // covered too: an empty recording and a missing model are both pre-checks
  // that must not be swallowed by the new branch.
  assert.deepEqual(await transcribe(new Float32Array(0)), { error: "Nothing was recorded." });
  assert.deepEqual(await transcribe(new Float32Array([0.1, 0.2, 0.3])), {
    error: "The speech model is missing from this build.",
  });
});
