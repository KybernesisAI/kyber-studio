import { test } from "node:test";
import assert from "node:assert/strict";

// No Electron imports in the module under test — the safeStorage object is
// passed in — so node --test can load it directly under --experimental-strip-types.
import {
  collectStorageDiagnostic,
  createCredentialStorageReporter,
  credentialStoreCanProtect,
  describeStorageDiagnostic,
  isCredentialStoreAvailable,
  readPasswordStoreOverride,
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
 * Two layers are tested here, and the split matters. `credentialStoreCanProtect`
 * is pure and unmemoised, so it carries the platform-by-backend matrix — the
 * memoised `isCredentialStoreAvailable` latches on its first call, and a matrix
 * written against it would pass every later case without exercising anything.
 * The reporter tests cover the printed line. The interesting cases are the ones
 * where the two answers disagree, and the ones where asking would throw.
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

/** Run the scheduled work immediately, for the tests that are not about timing. */
const immediately = (task) => task();

/** Let one turn of the event loop pass, so a deferred report has run. */
const nextTick = () => new Promise((resolve) => setImmediate(resolve));

test("the reporter speaks once, however many windows open", () => {
  // createWindow runs again on macOS 'activate'. A diagnostic that reprints
  // every time a window opens stops reading as a fact about the machine and
  // starts reading as noise.
  const lines = [];
  const report = createCredentialStorageReporter(fakeSafeStorage(), (l) => lines.push(l), immediately);

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
  let availabilityAsked = 0;
  const safeStorage = {
    isEncryptionAvailable: () => {
      availabilityAsked += 1;
      return true;
    },
    getSelectedStorageBackend: () => {
      asked += 1;
      return "gnome_libsecret";
    },
  };

  // The platform is pinned rather than inherited from the host. What is asserted
  // below is LINUX behaviour: asking for the backend at all only happens there.
  const report = createCredentialStorageReporter(safeStorage, () => {}, immediately, {
    platform: "linux",
    argv: [],
  });
  assert.equal(asked, 0, "constructing the reporter asked the OS anything at all");

  report();
  assert.equal(asked, 1);
  // KYB-590: the startup line is prompt-free. Measured on Linux Mint with a
  // locked keyring — getSelectedStorageBackend() raised no dialog across thirty
  // seconds, isEncryptionAvailable() raised one immediately. The diagnostic
  // keeps the backend name and defers the question that costs a prompt.
  assert.equal(availabilityAsked, 0, "the startup diagnostic asked about encryption and would prompt");
});

test("the call returns before the OS is asked, so nothing waits inside the handler", async () => {
  // Asking is what makes the OS unlock its keyring, and on a locked keyring
  // that blocks the main process until a password dialog is answered — which
  // may be a minute. Blocking inside the ready-to-show handler that made the
  // call would put everything else queued on the main process behind that
  // dialog, so the caller must be allowed to finish first.
  //
  // Note what this does NOT claim. The original argument for deferring was
  // that it would let the window paint first; measured on Linux Mint MATE with
  // a locked keyring, it does not — show() only starts the presentation. The
  // blank window behind the prompt is accepted; not blocking the handler is
  // the property worth keeping.
  let asked = 0;
  let availabilityAsked = 0;
  const safeStorage = {
    isEncryptionAvailable: () => {
      availabilityAsked += 1;
      return true;
    },
    getSelectedStorageBackend: () => {
      asked += 1;
      return "gnome_libsecret";
    },
  };

  const lines = [];
  // `undefined` for the schedule keeps the DEFAULT deferral, which is the
  // property under test here; the fourth argument pins the platform, because
  // asking for the backend at all is Linux-only behaviour.
  const report = createCredentialStorageReporter(safeStorage, (l) => lines.push(l), undefined, {
    platform: "linux",
    argv: [],
  });

  report();
  assert.equal(asked, 0, "the OS was asked on the caller's tick");
  assert.equal(lines.length, 0);

  await nextTick();

  assert.equal(asked, 1);
  assert.equal(availabilityAsked, 0, "the deferred report asked about encryption and would prompt");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[storage\] /);
  assert.match(lines[0], /encryptionAvailable=deferred/);
});

test("two calls before the deferred report runs still ask once", async () => {
  // The once-only latch has to close when the reporter is called, not when the
  // scheduled work runs — otherwise two windows opening in the same tick queue
  // two keyring questions, which is two password dialogs.
  let asked = 0;
  let availabilityAsked = 0;
  const safeStorage = {
    isEncryptionAvailable: () => {
      availabilityAsked += 1;
      return true;
    },
    getSelectedStorageBackend: () => {
      asked += 1;
      return "gnome_libsecret";
    },
  };

  const lines = [];
  // As above: default schedule, pinned platform.
  const report = createCredentialStorageReporter(safeStorage, (l) => lines.push(l), undefined, {
    platform: "linux",
    argv: [],
  });

  report();
  report();

  await nextTick();

  assert.equal(asked, 1);
  assert.equal(lines.length, 1);
});

test("off Linux the reporter never asks for the backend, and the line says why", () => {
  // The Linux-only guard in collectStorageDiagnostic has to survive the trip
  // through the reporter, which is a separate entry point with its own default.
  //
  // This test exists because it did not. Every reporter test in this file took
  // its platform from the HOST, so all of them asserted Linux behaviour and
  // three of them failed the first time the suite was run on a Mac — found by
  // the KYB-590 UAT tester before launching the app. The app was always right;
  // the tests simply never said which platform they were simulating.
  let asked = 0;
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => {
      asked += 1;
      return "gnome_libsecret";
    },
  };

  const lines = [];
  const report = createCredentialStorageReporter(safeStorage, (l) => lines.push(l), immediately, {
    platform: "darwin",
    argv: [],
  });

  report();

  assert.equal(asked, 0, "the Linux-only backend API was called on darwin");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /platform=darwin/);
  assert.match(lines[0], /backend=n\/a \(Linux-only API\)/);
});

/**
 * Deliberately last, and deliberately the only test in this file that touches
 * it: `isCredentialStoreAvailable` memoises for the life of the PROCESS, by
 * design and with no reset hook, so a second answer needs a second file. The
 * cross-layer property — one ask across a session read, a session write and an
 * MCP save — is in `credential-availability.test.mjs`, which is the process
 * where all three run.
 */
test("availability is asked once and then remembered, whoever asks", () => {
  let asked = 0;
  const safeStorage = {
    isEncryptionAvailable: () => {
      asked += 1;
      return true;
    },
  };

  assert.equal(isCredentialStoreAvailable(safeStorage), true);
  assert.equal(isCredentialStoreAvailable(safeStorage), true);
  // A second caller, standing in for the other layer: `controlPlane.ts` and
  // `localMcp.ts` share this one answer rather than holding one each.
  assert.equal(isCredentialStoreAvailable({ isEncryptionAvailable: () => false }), true);

  assert.equal(asked, 1, `asked the OS ${asked} times; each ask can raise an unlock dialog`);
});

test("an explicit --password-store is recorded, because it overrides detection", () => {
  // Without this the measurements are ambiguous: a machine forced onto
  // gnome-libsecret looks identical to one that chose it.
  const argv = ["/usr/bin/kyber-studio", "--password-store=gnome-libsecret"];

  assert.equal(readPasswordStoreOverride(argv), "gnome-libsecret");
  assert.match(
    describeStorageDiagnostic(collectStorageDiagnostic(fakeSafeStorage(), { platform: "linux", argv })),
    /passwordStore=gnome-libsecret/,
  );
});

test("the space-separated form of the switch is read too", () => {
  assert.equal(
    readPasswordStoreOverride(["/usr/bin/kyber-studio", "--password-store", "kwallet6"]),
    "kwallet6",
  );
});

test("with no switch the override reads as auto, not as absent", () => {
  assert.equal(readPasswordStoreOverride([]), null);
  assert.match(
    describeStorageDiagnostic(collectStorageDiagnostic(fakeSafeStorage(), { platform: "linux", argv: [] })),
    /passwordStore=auto/,
  );
});

test("the whole report is one line", () => {
  // It is read off a terminal on six VMs and pasted into a ticket. Two lines
  // is two things to copy and one thing to lose.
  for (const platform of ["linux", "darwin", "win32"]) {
    for (const backend of ["basic_text", "gnome_libsecret"]) {
      const line = describeStorageDiagnostic(
        collectStorageDiagnostic(fakeSafeStorage({ backend }), { platform, argv: [] }),
      );
      assert.equal(line.includes("\n"), false, `${platform}/${backend} printed more than one line`);
    }
  }
});

/**
 * The predicate, exhaustively.
 *
 * `credentialStoreCanProtect` is unmemoised precisely so this matrix can live in
 * one file. Its memoised caller latches for the life of the process and has no
 * reset hook by design, so a matrix written against the caller would pass every
 * case after the first without exercising anything — a test that cannot fail.
 * Separating the decision from the latch is what makes these assertions real.
 *
 * Several of these are the descendants of tests that asserted what the old
 * reporter PRINTED about a weak backend. The app now refuses to persist on one,
 * so the same conditions are asserted against the decision rather than a log line.
 */

test("on Linux a basic_text backend cannot protect anything, whatever availability claims", () => {
  // The whole lane in one assertion: availability said yes, the answer is no.
  assert.equal(
    credentialStoreCanProtect(fakeSafeStorage({ available: true, backend: "basic_text" }), {
      platform: "linux",
    }),
    false,
  );
});

test("on Linux the weak check runs first, so a machine that cannot protect is never prompted", () => {
  let asks = 0;
  const answer = credentialStoreCanProtect(
    {
      isEncryptionAvailable: () => {
        asks += 1;
        return true;
      },
      getSelectedStorageBackend: () => "basic_text",
    },
    { platform: "linux" },
  );

  assert.equal(answer, false);
  // Asking availability is what raises an unlock dialog; reading the name is
  // free. If this reads 1, the order has swapped and the fix now costs a prompt
  // on exactly the machines it cannot help.
  assert.equal(asks, 0);
});

test("on Linux a real backend defers to the availability answer, both ways", () => {
  for (const backend of ["gnome_libsecret", "kwallet6"]) {
    assert.equal(
      credentialStoreCanProtect(fakeSafeStorage({ available: true, backend }), { platform: "linux" }),
      true,
      `${backend} available`,
    );
    assert.equal(
      credentialStoreCanProtect(fakeSafeStorage({ available: false, backend }), { platform: "linux" }),
      false,
      `${backend} unavailable`,
    );
  }
});

test("on Linux the backend name is read once per decision, not twice", () => {
  let reads = 0;
  credentialStoreCanProtect(
    {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => {
        reads += 1;
        return "gnome_libsecret";
      },
    },
    { platform: "linux" },
  );

  assert.equal(reads, 1);
});

test("off Linux the backend is never asked for — it is a Linux-only API", () => {
  for (const platform of ["darwin", "win32"]) {
    let reads = 0;
    const store = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => {
        reads += 1;
        return "basic_text";
      },
    };

    // The stub answers basic_text on purpose. If the platform guard were
    // dropped, the answer would flip to false and this line would fail too —
    // so the test catches the crash-on-macOS mutation twice over.
    assert.equal(credentialStoreCanProtect(store, { platform }), true, platform);
    assert.equal(reads, 0, `${platform} reached a Linux-only API`);
  }
});

test("off Linux the availability answer is still honoured when it says no", () => {
  assert.equal(
    credentialStoreCanProtect(fakeSafeStorage({ available: false }), { platform: "darwin" }),
    false,
  );
});

test("a backend name we cannot read is not treated as weak", () => {
  // Deliberate direction: refusing here would take persistence away from every
  // Linux user on the strength of an API error, which is a worse failure than
  // the one this function exists to prevent.
  assert.equal(
    credentialStoreCanProtect(fakeSafeStorage({ available: true, throws: true }), {
      platform: "linux",
    }),
    true,
  );
});

test("an unrecognised backend is not assumed weak", () => {
  assert.equal(
    credentialStoreCanProtect(fakeSafeStorage({ available: true, backend: "kwallet5" }), {
      platform: "linux",
    }),
    true,
  );
});
