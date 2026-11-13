import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * An unreadable `session.bin` reads as signed out, never as an exception.
 *
 * `loadSession()` wraps its read in a `try/catch` that returns `null`, so a
 * truncated or foreign session file costs one re-sign-in and nothing more. That
 * is the fail-closed behaviour KYB-632 contrasts `device-id` with, and until
 * this file no test put an unreadable session in place, so removing the catch
 * would have passed the suite.
 *
 * `loadSession()` caches a good session in memory for the life of the process,
 * so every case here is a BAD file: the cache is never filled, and each case
 * really reads the file it wrote.
 */

const dir = mkdtempSync(join(tmpdir(), "kyb-session-unreadable-"));

mock.module("electron", {
  exports: {
    app: { getPath: () => dir },
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "gnome_libsecret",
      encryptString: (s) => Buffer.from(`ENC(${s})`, "utf8"),
      decryptString: (b) => {
        const match = /^ENC\((.*)\)$/s.exec(b.toString("utf8"));
        if (!match) throw new Error("not sealed by this store");
        return match[1];
      },
    },
    shell: { openExternal: async () => {} },
  },
});

const { loadSession } = await import("../src/main/controlPlane.ts");
const sessionPath = join(dir, "session.bin");

test("an empty session.bin reads as signed out", () => {
  writeFileSync(sessionPath, "");
  assert.equal(loadSession(), null);
});

test("a session.bin the store cannot decrypt reads as signed out", () => {
  writeFileSync(sessionPath, Buffer.from([0x76, 0x31, 0x30, 0x00, 0xff]));
  assert.equal(loadSession(), null);
});

test("a session.bin truncated mid-JSON reads as signed out", () => {
  writeFileSync(sessionPath, Buffer.from('ENC({"token":"header.e30.sig","refreshTo)', "utf8"));
  assert.equal(loadSession(), null);
});
