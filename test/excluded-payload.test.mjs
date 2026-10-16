import { test } from "node:test";
import assert from "node:assert/strict";

import { excludedPayloadIn, excludedPayloadVerdict } from "../scripts/lib/excluded-payload.mjs";

/**
 * What these tests exist to catch.
 *
 * This module is the only thing that can tell us an electron-builder exclusion
 * actually fired. A negation that matches zero files is silent, so a glob which
 * stops matching — because a path moved upstream, or a filename changed case —
 * removes megabytes of payload from the configuration's intent and nothing from
 * the package. The failure is invisible in a green build.
 *
 * Two of the cases below are regressions against mistakes already made in this
 * file's own history, and they are the reason the rest exist:
 *
 * - matching was first written CASE-SENSITIVELY, on the reasoning that the
 *   builder globs are case-sensitive. That is backwards. The globs being
 *   case-sensitive is exactly why an upstream `DirectML.DLL` gets packaged, so a
 *   case-sensitive check here agrees with the broken glob and reports a tick.
 * - paths reach this module from `path.relative`, which yields BACKSLASHES on
 *   Windows — and the Windows package is verified on Windows. Forward-slash
 *   rules would match nothing there, and the check would pass without having
 *   examined anything.
 *
 * Both of those produce a check that cannot fail, which is worse than no check:
 * it converts an unknown into a false assurance.
 */

const DX = { kind: "file", value: "DirectML.dll", why: "18.5 MB that nothing requests" };
const ARM64 = {
  kind: "tree",
  value: "node_modules/onnxruntime-node/bin/napi-v6/win32/arm64",
  why: "x64 is the only Windows arch built",
};
const CONTEXT = { filesKey: "build.win.files", layoutLabel: "Windows unpacked directory" };

const hit = (path, rule) => excludedPayloadIn([path], [rule]).length > 0;

test("a forbidden filename is found wherever it sits in the tree", () => {
  assert.equal(hit("resources/app.asar/node_modules/x/DirectML.dll", DX), true);
  assert.equal(hit("DirectML.dll", DX), true);
});

test("a filename whose case changed upstream is still found", () => {
  // The regression. An upstream release shipping DirectML.DLL stops matching a
  // case-sensitive glob and IS packaged; if this check mirrored the glob it
  // would miss precisely the file the check was added for.
  assert.equal(hit("bin/DirectML.DLL", DX), true);
  assert.equal(hit("bin/directml.dll", DX), true);
  assert.equal(hit("bin/DiReCtMl.DlL", DX), true);
});

test("a filename that merely contains the forbidden one is not a match", () => {
  assert.equal(hit("bin/NotDirectML.dll", DX), false);
  assert.equal(hit("bin/DirectML.dll.bak", DX), false);
  assert.equal(hit("bin/DirectML.dll/inner.txt", DX), false);
});

test("a forbidden tree matches itself and anything beneath it", () => {
  assert.equal(hit(`${ARM64.value}`, ARM64), true);
  assert.equal(hit(`${ARM64.value}/onnxruntime.dll`, ARM64), true);
  assert.equal(hit(`${ARM64.value}/deep/er/still.node`, ARM64), true);
});

test("a sibling tree sharing the forbidden tree's prefix is not a match", () => {
  // `win32/arm64` must not swallow `win32/arm64-extra`, and must not swallow
  // the x64 directory that is the whole point of the Windows build.
  assert.equal(hit(`${ARM64.value}-extra/onnxruntime.dll`, ARM64), false);
  assert.equal(hit("node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll", ARM64), false);
});

test("backslash paths match forward-slash rules, because this runs on Windows", () => {
  // The other regression. path.relative gives backslashes on win32 and the
  // Windows package is verified there.
  assert.equal(hit("node_modules\\onnxruntime-node\\bin\\napi-v6\\win32\\arm64\\x.dll", ARM64), true);
  assert.equal(hit("bin\\DirectML.DLL", DX), true);
});

test("a rule that matches nothing is not reported — it worked", () => {
  const violations = excludedPayloadIn(["out/main/index.js", "resources/app.asar"], [DX, ARM64]);
  assert.deepEqual(violations, []);
});

test("each violated rule carries every path that violated it", () => {
  const paths = ["a/DirectML.dll", "b/DirectML.DLL", "c/keep.dll"];
  const violations = excludedPayloadIn(paths, [DX]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, DX);
  assert.deepEqual(violations[0].paths, ["a/DirectML.dll", "b/DirectML.DLL"]);
});

test("violations come back in the order the layout declared them", () => {
  const paths = [`${ARM64.value}/x.dll`, "a/DirectML.dll"];
  assert.deepEqual(
    excludedPayloadIn(paths, [DX, ARM64]).map((v) => v.rule.value),
    [DX.value, ARM64.value],
  );
  assert.deepEqual(
    excludedPayloadIn(paths, [ARM64, DX]).map((v) => v.rule.value),
    [ARM64.value, DX.value],
  );
});

test("declaring no exclusions is not reported as a clean package", () => {
  // A layout with nothing declared has verified nothing. Saying "no excluded
  // payload present" would be a false assurance about a tree nobody examined,
  // so the wording has to say what it did not do, and checked must be 0.
  const verdict = excludedPayloadVerdict(["anything"], [], CONTEXT);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.checked, 0);
  const text = verdict.lines.join("\n");
  assert.match(text, /none were checked/);
  assert.doesNotMatch(text, /are absent from the package/);
});

test("a clean package reports how many exclusions were actually checked", () => {
  const verdict = excludedPayloadVerdict(["out/main/index.js"], [DX, ARM64], CONTEXT);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.checked, 2);
  assert.match(verdict.lines.join("\n"), /all 2 declared exclusions are absent/);
});

test("a violation fails, and names the key a reader can edit", () => {
  const verdict = excludedPayloadVerdict(["bin/DirectML.DLL"], [DX, ARM64], CONTEXT);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.checked, 2);
  const text = verdict.lines.join("\n");
  assert.match(text, /build\.win\.files/);
  assert.match(text, /bin\/DirectML\.DLL/);
  assert.match(text, /18\.5 MB that nothing requests/);
  // The rule that was satisfied must not be listed as a failure.
  assert.doesNotMatch(text, /arm64/);
});

test("the report names every violating path, so none is hidden behind a count", () => {
  const paths = ["a/DirectML.dll", "b/DirectML.DLL", `${ARM64.value}/x.dll`];
  const verdict = excludedPayloadVerdict(paths, [DX, ARM64], CONTEXT);
  assert.equal(verdict.ok, false);
  const text = verdict.lines.join("\n");
  for (const path of paths) assert.match(text, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("unmodelled exclusions are reported with their count, not as nothing to check", () => {
  // The distinction this exists for: macOS and Linux both exclude paths that no
  // layout models yet. "none were checked" is true of both that and a manifest
  // with no exclusions at all, and those are not the same situation. A reader
  // seeing a 7 knows there is something to do.
  const verdict = excludedPayloadVerdict(["anything"], [], { ...CONTEXT, declaredCount: 7 });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.checked, 0);
  const text = verdict.lines.join("\n");
  assert.match(text, /7 path\(s\) excluded by build\.win\.files are not modelled/);
  assert.doesNotMatch(text, /no exclusions are declared/);
  assert.doesNotMatch(text, /are absent from the package/);
});
