import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeAtomic } from "../src/main/atomicWrite.ts";

/**
 * KYB-616: what actually keeps the secrets containers owner-only on Windows.
 *
 * Every secrets write passes `mode: 0o600`, and on Windows that does nothing
 * useful — node maps a mode onto the read-only attribute and nothing else. What
 * protects `local-mcp.json`, `local-permissions.json`, `session.bin` and
 * `device-id` there is the ACL they INHERIT from the app's `userData`
 * directory, which sits under `%APPDATA%`. The decision recorded on the ticket
 * was to rely on that rather than set an ACL of our own, so this file is the
 * reliance written down as something that can fail.
 *
 * The property asserted is the one the decision rests on: no Allow entry for
 * the three broad local groups. Measured on a Windows 11 machine on 13 October
 * 2026, the inherited ACL carried exactly the interactive user, SYSTEM and
 * Administrators. An allowlist of those three would be stricter, and is not
 * what is asserted, because the named-user entries on a CI runner's profile are
 * not ours to predict, and a red arm for a reason about the runner rather than
 * the app is the kind nobody can act on.
 *
 * What this cannot say: that a local ADMINISTRATOR is kept out. They are not,
 * here or anywhere — the same position as `root` against a POSIX `0600` file.
 */

const WINDOWS_ONLY = process.platform !== "win32" && "ACLs are a Windows mechanism; POSIX modes are covered in atomic-write.test.mjs";

/**
 * Well-known SIDs, not names. `icacls` and `Get-Acl` print account names in the
 * machine's language — "Everyone" is "Jeder" on a German install — so matching
 * on names would pass on every non-English machine whatever the ACL said.
 */
const BROAD = {
  "S-1-1-0": "Everyone",
  "S-1-5-11": "Authenticated Users",
  "S-1-5-32-545": "BUILTIN\\Users",
};

const POWERSHELL = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

/**
 * Every access rule on `path`, explicit and inherited, keyed by SID.
 *
 * **Built so that it cannot quietly read nothing**, because the first version
 * did. On the CI runner, Windows PowerShell 5.1 could not load the module that
 * provides `Get-Acl`. It printed an error, carried on, and handed back one
 * empty record, and the main test then PASSED against an ACL it had never read.
 * The negative control below caught it. So:
 *
 * - no Security-module cmdlet: `GetAccessControl()` is a .NET method on the
 *   file object, so `Get-Acl`'s module is never needed. `Get-Item` and
 *   `ConvertTo-Json` still autoload their own modules, which is why the next
 *   three bullets matter;
 * - `$ErrorActionPreference = 'Stop'`, so any error ends the process non-zero
 *   and `execFileSync` throws, instead of a half-run script printing JSON;
 * - `PSModulePath` is removed from the child's environment. When node itself
 *   runs under PowerShell 7, as on the runner, that variable carries 7's module
 *   paths into 5.1, which is the usual cause of exactly this failure;
 * - and whatever comes back is validated: an empty ACL, or any rule without a
 *   real SID, is an error and not an answer.
 *
 * Asks for the rules AS SecurityIdentifier rather than translating names
 * afterwards, so an orphaned SID cannot make the translation throw. The path
 * travels in an environment variable rather than on the command line, so no
 * quoting rule of any shell is involved.
 */
function accessRules(path) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$acl = (Get-Item -LiteralPath $env:KYB_ACL_TARGET -Force).GetAccessControl('Access')",
    "$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])",
    "$out = @($rules | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Value; type = \"$($_.AccessControlType)\"; rights = \"$($_.FileSystemRights)\"; inherited = $_.IsInherited } })",
    "ConvertTo-Json -InputObject $out -Compress",
  ].join("; ");
  const env = { ...process.env, KYB_ACL_TARGET: path };
  // Case-insensitively: Windows treats env names that way, a spread copy does not.
  for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
  const json = execFileSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script], { env, encoding: "utf8" });

  const rules = JSON.parse(json);
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error(`read no access rules at all for ${path}, which no real file has: ${json}`);
  }
  const unreadable = rules.filter((rule) => typeof rule.sid !== "string" || !rule.sid.startsWith("S-1-"));
  if (unreadable.length > 0) {
    throw new Error(`read rules without a SID for ${path}, so the ACL was not actually read: ${json}`);
  }
  return rules;
}

/** The Allow entries `path` grants to any of the broad groups. Empty is the pass. */
function broadGrants(path) {
  return accessRules(path)
    .filter((rule) => rule.type === "Allow" && rule.sid in BROAD)
    .map((rule) => `${BROAD[rule.sid]} (${rule.sid}): ${rule.rights}${rule.inherited ? ", inherited" : ""}`);
}

/** Written exactly as the real call sites write a secrets container. */
function writeContainer(dir) {
  const file = join(dir, "local-mcp.json");
  writeAtomic(file, JSON.stringify({ servers: [] }), { mode: 0o600 });
  return file;
}

test("a secrets container written under %APPDATA% grants nothing to the broad local groups", { skip: WINDOWS_ONLY }, (t) => {
  // The app's real userData is %APPDATA%\kyber-studio, created by Electron with
  // a plain mkdir. A fresh sibling created the same way inherits the same ACL,
  // and is ours to delete — the real directory is not, on a developer's machine.
  const appData = process.env.APPDATA;
  assert.ok(appData, "APPDATA is unset, so there is no per-user directory to rely on at all");

  const dir = join(appData, `kyb-616-acl-${process.pid}-${Date.now()}`);
  mkdirSync(dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const file = writeContainer(dir);

  // Printed whatever the outcome: on a red run this is the evidence, and on a
  // green one it is the measurement the ticket asked for, from a second machine.
  t.diagnostic(`directory ACL: ${JSON.stringify(accessRules(dir))}`);
  t.diagnostic(`file ACL: ${JSON.stringify(accessRules(file))}`);

  assert.deepEqual(broadGrants(dir), [], "the directory is readable by a broad group");
  // The file matters separately from the directory: `writeAtomic` publishes by
  // rename, so the file carries whatever its temp was created with.
  assert.deepEqual(broadGrants(file), [], "the published container is readable by a broad group");
});

test("the check can fail: a deliberately permissive directory is caught", { skip: WINDOWS_ONLY }, (t) => {
  // Without this the test above could pass by reading nothing. A checker that
  // returned [] for every path — a broken PowerShell call, a JSON shape that
  // never matches, a SID compared against a name — would pass it for ever.
  const dir = mkdtempSync(join(tmpdir(), "kyb-616-permissive-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Grant read to EACH broad group, inherited by anything created inside, so
  // every SID the checker relies on is shown to be caught — not just one.
  // `*S-1-…` is icacls's SID syntax, so this works on a machine in any language.
  const grants = Object.keys(BROAD).map((sid) => `*${sid}:(OI)(CI)R`);
  execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), [dir, "/grant", ...grants]);

  const file = writeContainer(dir);

  const onDir = broadGrants(dir);
  const onFile = broadGrants(file);
  for (const [sid, name] of Object.entries(BROAD)) {
    assert.ok(
      onDir.some((grant) => grant.includes(`(${sid})`)),
      `the checker missed an explicit ${name} grant on the directory: ${JSON.stringify(accessRules(dir))}`
    );
    assert.ok(
      onFile.some((grant) => grant.includes(`(${sid})`)),
      `the checker missed ${name} inherited onto the published file: ${JSON.stringify(accessRules(file))}`
    );
  }
});
