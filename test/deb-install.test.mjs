import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEB_UPDATE_HELPER,
  DPKG_DEB,
  DPKG_QUERY,
  PKEXEC,
  SYSTEM_PATH,
  installDebUpdate,
  notInstalledMessage,
  systemRun,
} from "../src/main/debInstall.ts";

/**
 * KYB-670: the `.deb` install step decides by the installed version, never by
 * an exit code. On the measured cancel-then-approve path, electron-updater's
 * own install ran a command that exited 0 and left the old version installed,
 * and Studio restarted as if updated.
 *
 * These drive `installDebUpdate` with a fake `run` standing in for dpkg-deb,
 * pkexec and dpkg-query, so each decision is exercised without a package
 * manager. The fake's dpkg state changes only when the "install" it is given
 * says so, which is what lets one test make the install exit 0 and change
 * nothing.
 */

const DEB = "/home/<user>/.cache/kyber-studio-updater/pending/kyber-studio_0.5.23_amd64.deb";

/**
 * A fake system: `installed` is what dpkg-query reports; `install` decides what
 * running the helper does (its exit status, and what is installed afterwards).
 */
function system({
  package: pkgName = "kyber-studio",
  version = "0.5.23",
  installed = { version: "0.5.22", abbrev: "ii " },
  install = () => ({ status: 0, after: { version, abbrev: "ii " } }),
  helperExists = true,
} = {}) {
  const calls = [];
  let current = installed;
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (command === DPKG_DEB) {
      // Pinned as literals, like the dpkg-query format below: comparing with
      // the imported constants would follow any change to them and never fail.
      assert.equal(command, "/usr/bin/dpkg-deb");
      assert.deepEqual(args, ["-f", DEB, "Package", "Version"]);
      return { status: 0, stdout: `Package: ${pkgName}\nVersion: ${version}\n`, stderr: "" };
    }
    if (command === DPKG_QUERY) {
      // Pinned, so a change to the format the parser depends on goes red here
      // rather than reading every install as "not installed" on a real system.
      assert.equal(command, "/usr/bin/dpkg-query");
      assert.deepEqual(args, ["-W", "-f=${Version}\\t${db:Status-Abbrev}", "kyber-studio"]);
      if (!current) return { status: 1, stdout: "", stderr: "no packages found" };
      return { status: 0, stdout: `${current.version}\t${current.abbrev}`, stderr: "" };
    }
    if (command === PKEXEC || command === DEB_UPDATE_HELPER) {
      if (command === PKEXEC) assert.equal(command, "/usr/bin/pkexec");
      const r = install(command, args);
      if (r.after !== undefined) current = r.after;
      return { status: r.status ?? null, stdout: "", stderr: r.stderr ?? "", error: r.error };
    }
    throw new Error(`unexpected command ${command}`);
  };
  return { calls, run, exists: (p) => helperExists && p === DEB_UPDATE_HELPER };
}

const go = (s, isRoot = false) => installDebUpdate({ debPath: DEB, isRoot, run: s.run, exists: s.exists });

test("an install that exits 0 but leaves the old version installed is NOT installed", () => {
  // The measured case: cancel the first prompt, approve `apt-get install -f -y`,
  // which has nothing to fix and exits 0. Here: the install exits 0 and
  // changes nothing.
  const s = system({ install: () => ({ status: 0 }) });
  const result = go(s);
  assert.equal(result.installed, false);
  assert.equal(result.reason, "failed");
  assert.equal(result.expected, "0.5.23");
  assert.equal(result.found, "0.5.22");
});

test("the new version, fully installed, is installed", () => {
  const s = system();
  assert.deepEqual(go(s), { installed: true, version: "0.5.23" });
});

test("the version check, not the exit code, decides success too", () => {
  // A non-zero exit that nonetheless left the new version fully installed
  // (for example the helper's dependency fix-up) is a success.
  const s = system({ install: () => ({ status: 1, after: { version: "0.5.23", abbrev: "ii " } }) });
  assert.equal(go(s).installed, true);
});

test("the new version unpacked but not configured is not installed", () => {
  for (const abbrev of ["iU ", "iF "]) {
    const s = system({ install: () => ({ status: 1, after: { version: "0.5.23", abbrev } }) });
    const result = go(s);
    assert.equal(result.installed, false, abbrev);
    assert.equal(result.found, "0.5.23 (not fully installed)", abbrev);
  }
});

test("one prompt, for the helper, naming the download as a single argument; nothing runs after a cancel", () => {
  const s = system({ install: () => ({ status: 126 }) });
  const result = go(s);
  assert.equal(result.installed, false);
  assert.equal(result.reason, "declined");
  const privileged = s.calls.filter(([c]) => c === PKEXEC || c === DEB_UPDATE_HELPER);
  assert.deepEqual(privileged, [[PKEXEC, "--disable-internal-agent", DEB_UPDATE_HELPER, DEB]]);
  // No apt-get, no bash, no second attempt: the only commands are reads.
  assert.deepEqual(
    s.calls.map(([c]) => c),
    [DPKG_DEB, PKEXEC, DPKG_QUERY],
  );
});

test("pkexec's 127 is not-authorised, and a missing pkexec is said as such", () => {
  assert.equal(go(system({ install: () => ({ status: 127 }) })).reason, "not-authorised");
  const missing = go(
    system({ install: () => ({ status: null, error: { code: "ENOENT", message: "spawnSync /usr/bin/pkexec ENOENT" } }) }),
  );
  assert.equal(missing.reason, "no-pkexec");
});

test("as root, the helper runs directly with no prompt", () => {
  const s = system();
  assert.equal(go(s, true).installed, true);
  assert.ok(s.calls.some(([c, a]) => c === DEB_UPDATE_HELPER && a === DEB));
  assert.ok(!s.calls.some(([c]) => c === PKEXEC));
});

test("a missing helper refuses, rather than falling back to an anonymous prompt", () => {
  const s = system({ helperExists: false });
  const result = go(s);
  assert.equal(result.reason, "no-helper");
  assert.ok(!s.calls.some(([c]) => c === PKEXEC), "nothing privileged may run");
});

test("a download that is not a kyber-studio package is refused before any prompt", () => {
  const s = system({ package: "something-else" });
  assert.equal(go(s).reason, "not-our-package");
  assert.ok(!s.calls.some(([c]) => c === PKEXEC));
});

test("the row's message says the update was not installed, and why when known", () => {
  const s = system({ install: () => ({ status: 126 }) });
  assert.equal(notInstalledMessage(go(s)), "The update to v0.5.23 was not installed: the password prompt was cancelled.");
  const failed = system({ install: () => ({ status: 0 }) });
  assert.equal(notInstalledMessage(go(failed)), "The update to v0.5.23 was not installed.");
});

test(
  "the commands run with a fixed PATH, not the one Studio inherited",
  { skip: process.platform === "win32" ? "no /usr/bin/env on Windows" : false },
  () => {
    // dpkg-deb runs `tar` through PATH, and its output is the version the
    // install is judged against, so a planted `tar` early on an inherited PATH
    // could make a cancelled install read as installed.
    assert.equal(SYSTEM_PATH, "/usr/sbin:/usr/bin:/sbin:/bin");
    const saved = process.env.PATH;
    process.env.PATH = `/tmp/planted-bin:${saved}`;
    try {
      const r = systemRun("/usr/bin/env", []);
      assert.equal(r.status, 0, r.stderr);
      const path = r.stdout.split("\n").find((line) => line.startsWith("PATH="));
      assert.equal(path, "PATH=/usr/sbin:/usr/bin:/sbin:/bin");
    } finally {
      process.env.PATH = saved;
    }
  },
);
