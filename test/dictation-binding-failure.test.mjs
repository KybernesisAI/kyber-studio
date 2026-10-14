import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * KYB-631, the end-to-end half: `transcribe()`'s own `catch`, entered for real.
 *
 * The sibling file, `dictation-error-message.test.mjs`, drives the classifier
 * directly and deliberately has no model on disk, so every call there returns
 * at the `dictationAvailable()` pre-check. That leaves the actual wiring —
 * `return { error: dictationErrorMessage(error) }`, and the `console.error`
 * beside it — covered by reading rather than by running, which round 1 of the
 * review called out as the one unproven part of the change.
 *
 * So this file gives dictation a model to find and a pipeline that fails the
 * way a Windows machine with an old MSVC runtime fails, and asserts on what
 * comes back out of `transcribe()`.
 *
 * `process.resourcesPath` is set rather than relying on `app.getAppPath()`,
 * because `modelRoot()` checks the packaged locations first and the fallback
 * resolves relative to the working directory — which would make this test
 * depend on where it was run from.
 */

// `transcribe()` reads the real `process.platform`, so the Windows branch is
// unreachable on a Linux runner without this. Forced for the whole file, which
// also makes the two NEGATIVE tests below meaningful — on Linux they would pass
// trivially, because nothing maps to the guidance there at all.
const realPlatform = process.platform;
Object.defineProperty(process, "platform", { value: "win32", configurable: true });
after(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

const dir = mkdtempSync(join(tmpdir(), "kyb-dictation-e2e-"));
mkdirSync(join(dir, "resources", "models", "Xenova", "whisper-base.en"), { recursive: true });
process.resourcesPath = dir;

mock.module("electron", {
  exports: { app: { getPath: () => dir, getAppPath: () => dir } },
});

/**
 * What the pipeline does. Swapped per test, before `transcribe()` is called.
 *
 * `null` means succeed, returning a transcriber that produces fixed text —
 * needed for the retry test, which is the one case that must NOT fail.
 */
let failure = new Error("not configured");

mock.module("@huggingface/transformers", {
  exports: {
    env: {},
    // The real failure happens while importing this module; a throwing export
    // reaches the same `catch` by the same route, and is the only shape a
    // module mock can express.
    pipeline: async () => {
      if (failure) throw failure;
      return async () => ({ text: "it works now" });
    },
  },
});

const { transcribe } = await import("../src/main/dictation.ts");

const WIN32_DLL_INIT =
  "A dynamic link library (DLL) initialization routine failed. " +
  "\\\\?\\C:\\Users\\pholder\\AppData\\Local\\Programs\\KYBER Studio\\resources\\" +
  "app.asar.unpacked\\node_modules\\onnxruntime-node\\bin\\napi-v6\\win32\\x64\\onnxruntime_binding.node";

const AUDIO = new Float32Array([0.1, -0.2, 0.3]);

function dlopenError(message) {
  const error = new Error(message);
  error.code = "ERR_DLOPEN_FAILED";
  return error;
}

test("the binding failure comes out of transcribe() as guidance", async (t) => {
  // The claim the whole ticket rests on, through the real function: a Windows
  // user gets the sentence instead of the Win32 string.
  t.mock.method(console, "error", () => {});
  failure = dlopenError(WIN32_DLL_INIT);

  const result = await transcribe(AUDIO);

  assert.equal(result.text, undefined);
  assert.match(result.error, /Microsoft Visual C\+\+ 2015-2022 x64 Redistributable/);
  assert.ok(!result.error.includes("pholder"), "the account name must not reach the renderer");
  assert.ok(!/[A-Za-z]:\\/.test(result.error), `a Windows path reached the renderer: ${result.error}`);
});

test("the raw text goes to the log, where somebody debugging can still get it", async (t) => {
  // Criterion 3, executed rather than read. The whole error object is logged,
  // so the path and the code are both recoverable.
  const logged = t.mock.method(console, "error", () => {});
  failure = dlopenError(WIN32_DLL_INIT);

  await transcribe(AUDIO);

  assert.equal(logged.mock.callCount(), 1);
  const [prefix, error] = logged.mock.calls[0].arguments;
  assert.match(prefix, /dictation/);
  assert.equal(error.code, "ERR_DLOPEN_FAILED");
  assert.ok(error.message.includes("pholder"), "the log must keep what the UI drops");
});

test("an unrelated pipeline failure keeps its own words end to end", async (t) => {
  // The catch must not have become a funnel that answers everything with the
  // redistributable.
  t.mock.method(console, "error", () => {});
  failure = new Error("Unable to load model from file");

  assert.deepEqual(await transcribe(AUDIO), { error: "Unable to load model from file" });
});

test("a sharp-shaped load failure is NOT recognised — known limitation, pinned", async (t) => {
  // Round 1 of the review established that `sharp` is statically imported in
  // the same module graph as the dictation pipeline and wraps its own load
  // failure in a bare Error: no `code`, no `cause`, and no mention of the ONNX
  // binding. So neither signal fires and the user sees sharp's help text.
  //
  // This is pinned rather than fixed. The outcome is an unhelpful message,
  // which is the status quo for that path, and guessing "install the MSVC
  // runtime" at a sharp failure would send somebody to install a runtime that
  // is not the problem. If this test ever starts failing, someone has widened
  // the classifier — which may be right, but should be a decision rather than
  // an accident.
  t.mock.method(console, "error", () => {});
  failure = new Error(
    "Could not load the sharp module using the win32-x64 runtime\n" +
      "Possible solutions:\n- Please add the platform-specific dependency"
  );

  const result = await transcribe(AUDIO);

  assert.ok(!result.error.includes("Redistributable"), "sharp failures must not claim the MSVC remedy");
  assert.match(result.error, /Could not load the sharp module/);
});

test("our own load latch does not block a second attempt", async (t) => {
  // Found by this file rather than by review: `load()` latches `loading` before
  // anything else, so a retained rejected promise handed every later attempt
  // the FIRST failure for the life of the process. The guidance tells somebody
  // to install the redistributable and try again, and that instruction was
  // impossible to satisfy — the second attempt never reached the loader.
  //
  // **READ THIS BEFORE TRUSTING THE NAME.** What is asserted here is narrow: OUR
  // latch is cleared. It is not evidence that a user can retry without
  // restarting, and the Windows UAT on 14 Oct 2026 measured that they cannot —
  // restoring the binding and pressing the button again produced the same
  // guidance message. The reason is above this test's reach: `load()` goes
  // through `await import("@huggingface/transformers")`, and a module graph that
  // throws while evaluating stays errored in the ESM registry for the life of
  // the process. This file mocks that module, so a second import gets a fresh
  // mock instead of the registry's cached failure — which is exactly why the
  // test passes where the product does not. The "restart KYBER Studio" in the
  // guidance is therefore load-bearing, not politeness. Do not delete it on the
  // strength of this test.
  t.mock.method(console, "error", () => {});

  failure = dlopenError(WIN32_DLL_INIT);
  const before = await transcribe(AUDIO);
  assert.match(before.error, /Redistributable/);

  // Stands in for the user installing the runtime and pressing the button again.
  failure = null;
  const after_ = await transcribe(AUDIO);

  assert.equal(after_.error, undefined, `a retry still failed: ${after_.error}`);
  assert.equal(after_.text, "it works now");
});
