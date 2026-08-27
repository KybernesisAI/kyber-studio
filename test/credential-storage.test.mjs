import { test } from "node:test";
import assert from "node:assert/strict";

// No Electron imports in the module under test — the safeStorage object is
// passed in — so node --test can load it directly under --experimental-strip-types.
import {
  collectCredentialStorage,
  createCredentialStorageReporter,
  describeCredentialStorage,
} from "../src/main/credentialStorage.ts";

/**
 * What this diagnostic exists to catch.
 *
 * `safeStorage.isEncryptionAvailable()` returns true on Linux even when the
 * chosen backend is `basic_text`, which "encrypts" with a hard-coded public
 * key. Nothing in the app has ever asked which backend was selected, so the
 * weak case has been invisible: the promise in controlPlane.ts is kept on some
 * machines and quietly broken on others, and we cannot tell which is which.
 *
 * These tests are about the honesty of one printed line. The interesting cases
 * are the ones where the two answers disagree, and the ones where asking the
 * question at all would throw.
 */

/** A stand-in for Electron's safeStorage, so no Electron is needed here. */
function fakeSafeStorage({ available = true, backend = "gnome_libsecret", throws = false } = {}) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => {
      if (throws) throw new Error("not available on this platform");
      return backend;
    },
  };
}

test("on Linux it reports the backend beside the availability answer", () => {
  const report = collectCredentialStorage(fakeSafeStorage({ backend: "gnome_libsecret" }), {
    platform: "linux",
    argv: ["/usr/bin/kyber-studio"],
  });

  assert.equal(report.platform, "linux");
  assert.equal(report.encryptionAvailable, true);
  assert.equal(report.backend, "gnome_libsecret");
  assert.equal(report.override, null);
  assert.equal(report.weak, false);
});

test("basic_text with encryption 'available' is the case worth shouting about", () => {
  // This is the disagreement. Reporting it as a plain fact is the whole point:
  // a machine in this state looks safe from inside the app and is not.
  const report = collectCredentialStorage(fakeSafeStorage({ available: true, backend: "basic_text" }), {
    platform: "linux",
    argv: [],
  });

  assert.equal(report.weak, true);

  const line = describeCredentialStorage(report);
  assert.match(line, /basic_text/);
  assert.match(line, /hard-coded key/);
});

test("a real backend produces no warning", () => {
  const line = describeCredentialStorage(
    collectCredentialStorage(fakeSafeStorage({ backend: "kwallet6" }), {
      platform: "linux",
      argv: [],
    }),
  );

  assert.match(line, /backend=kwallet6/);
  assert.doesNotMatch(line, /hard-coded key/);
});

test("off Linux the backend is never asked for", () => {
  // getSelectedStorageBackend is a Linux-only API. Calling it on macOS is how
  // a diagnostic turns into a crash on the platform that was working.
  let asked = false;
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => {
      asked = true;
      return "unreachable";
    },
  };

  const report = collectCredentialStorage(safeStorage, { platform: "darwin", argv: [] });

  assert.equal(asked, false);
  assert.equal(report.backend, null);
  assert.equal(report.encryptionAvailable, true);
  assert.equal(report.weak, false);
  assert.match(describeCredentialStorage(report), /platform=darwin/);
});

test("a throwing backend call is reported, not propagated", () => {
  // A diagnostic that can take the app down is worse than no diagnostic.
  const report = collectCredentialStorage(fakeSafeStorage({ throws: true }), {
    platform: "linux",
    argv: [],
  });

  assert.equal(report.backend, null);
  assert.match(describeCredentialStorage(report), /backend=unknown/);
});

test("an explicit --password-store is recorded, because it overrides detection", () => {
  // Without this the measurements are ambiguous: a machine forced onto
  // gnome-libsecret looks identical to one that chose it.
  const report = collectCredentialStorage(fakeSafeStorage(), {
    platform: "linux",
    argv: ["/usr/bin/kyber-studio", "--password-store=gnome-libsecret"],
  });

  assert.equal(report.override, "gnome-libsecret");
  assert.match(describeCredentialStorage(report), /passwordStore=gnome-libsecret/);
});

test("the space-separated form of the switch is read too", () => {
  const report = collectCredentialStorage(fakeSafeStorage(), {
    platform: "linux",
    argv: ["/usr/bin/kyber-studio", "--password-store", "kwallet6"],
  });

  assert.equal(report.override, "kwallet6");
});

test("with no switch the override reads as auto, not as absent", () => {
  const line = describeCredentialStorage(
    collectCredentialStorage(fakeSafeStorage(), { platform: "linux", argv: [] }),
  );

  assert.match(line, /passwordStore=auto/);
});

test("the whole report is one line", () => {
  // It is read off a terminal on six VMs and pasted into a ticket. Two lines
  // is two things to copy and one thing to lose.
  for (const platform of ["linux", "darwin", "win32"]) {
    for (const backend of ["basic_text", "gnome_libsecret"]) {
      const line = describeCredentialStorage(
        collectCredentialStorage(fakeSafeStorage({ backend }), { platform, argv: [] }),
      );
      assert.equal(line.includes("\n"), false, `${platform}/${backend} wrapped`);
      assert.match(line, /^\[storage\] /);
    }
  }
});

test("the reporter speaks once, however many windows open", () => {
  // createWindow runs again on macOS 'activate'. A diagnostic that reprints
  // every time a window opens stops reading as a fact about the machine and
  // starts reading as noise.
  const lines = [];
  const report = createCredentialStorageReporter(fakeSafeStorage(), (l) => lines.push(l));

  report();
  report();
  report();

  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[storage\] /);
});

test("the reporter does not touch the keyring until it is called", () => {
  // This is the regression that made the fix necessary. Asking these questions
  // is what makes the OS unlock its keyring, and on Linux that can raise a
  // password dialog and block the main process until it is answered. Built at
  // module scope and called from whenReady, it put that dialog in front of a
  // user with no application window behind it — observed on Linux Mint MATE,
  // where the window did not appear until the dialog was dealt with.
  //
  // Construction must therefore be inert; only the call may ask.
  let asked = 0;
  const safeStorage = {
    isEncryptionAvailable: () => {
      asked += 1;
      return true;
    },
    getSelectedStorageBackend: () => "gnome_libsecret",
  };

  const report = createCredentialStorageReporter(safeStorage, () => {});
  assert.equal(asked, 0, "constructing the reporter asked the OS about encryption");

  report();
  assert.equal(asked, 1);
});
