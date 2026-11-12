import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `deviceId()` must not hand out an identity it cannot vouch for (KYB-632).
 *
 * The id is written once and read on every later call, so whatever is on disk
 * is what the control plane is told, launch after launch. A torn write leaves
 * an empty or partial file behind, and a read guarded only by `existsSync`
 * returned that residue for ever, with nothing logged. These tests put the
 * residue in place directly rather than provoking the torn write.
 *
 * The case with a VALID file is here on purpose: a version that regenerated on
 * every call would pass the empty and truncated cases, and would give the
 * machine a new identity at every launch.
 */

const dir = mkdtempSync(join(tmpdir(), "kyb-device-id-"));

mock.module("electron", {
  exports: {
    app: { getPath: () => dir },
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "gnome_libsecret",
      encryptString: (s) => Buffer.from(s, "utf8"),
      decryptString: (b) => b.toString("utf8"),
    },
    shell: { openExternal: async () => {} },
  },
});

const { deviceId } = await import("../src/main/controlPlane.ts");

const idPath = join(dir, "device-id");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const posix = process.platform !== "win32";

let warn;
beforeEach(() => {
  rmSync(idPath, { force: true });
  warn?.mock.restore();
  warn = mock.method(console, "warn", () => {});
});

function assertRegenerated(before) {
  const id = deviceId();
  assert.match(id, UUID, `expected a well-formed UUID, got ${JSON.stringify(id)}`);
  assert.notEqual(id, before.trim());
  assert.equal(readFileSync(idPath, "utf8"), id, "the file on disk must now hold the returned id");
  assert.equal(existsSync(`${idPath}.tmp`), false, "no temporary file may be left behind");
  if (posix) assert.equal(statSync(idPath).mode & 0o777, 0o600);
  assert.equal(warn.mock.callCount(), 1, "the replacement must be logged once");
  assert.ok(
    String(warn.mock.calls[0].arguments[0]).includes(idPath),
    "the warning must name the file it replaced",
  );
  assert.equal(deviceId(), id, "the regenerated id must be the one read back next time");
  assert.equal(warn.mock.callCount(), 1, "reading the healed file must not warn again");
}

test("an empty device-id file is replaced with a fresh id, written and logged", () => {
  writeFileSync(idPath, "");
  assertRegenerated("");
});

test("a truncated device-id file is replaced with a fresh id, written and logged", () => {
  writeFileSync(idPath, "550e8400-e29b-41d4");
  assertRegenerated("550e8400-e29b-41d4");
});

test("a well-formed device-id is returned as stored, without rewriting or warning", () => {
  const stored = "550e8400-e29b-41d4-a716-446655440000";
  writeFileSync(idPath, `${stored}\n`);
  const mtime = statSync(idPath).mtimeMs;
  assert.equal(deviceId(), stored);
  assert.equal(deviceId(), stored);
  assert.equal(readFileSync(idPath, "utf8"), `${stored}\n`, "a valid file must not be rewritten");
  assert.equal(statSync(idPath).mtimeMs, mtime);
  assert.equal(warn.mock.callCount(), 0);
});

test("with no device-id file, a fresh id is written with mode 0600 and nothing is logged", () => {
  const id = deviceId();
  assert.match(id, UUID);
  assert.equal(readFileSync(idPath, "utf8"), id);
  assert.equal(existsSync(`${idPath}.tmp`), false);
  if (posix) assert.equal(statSync(idPath).mode & 0o777, 0o600);
  assert.equal(warn.mock.callCount(), 0, "a first launch is not a repair and must not warn");
  assert.equal(deviceId(), id);
});
