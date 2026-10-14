// KYB-621 probe: does writeAtomic's renameSync fail when ANOTHER PROCESS holds the target open?
// Temporary; runs on windows-latest only. Uses the repository's real writeAtomic.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAtomic } from "../../src/main/atomicWrite.ts";

const PS = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== "psmodulepath"));

// Holder: opens the file with a chosen FileShare, prints "held", sleeps, closes. No cmdlets, so no module autoload.
function psHolder(target, share, holdMs, access = "Read") {
  const script = `$f=[System.IO.File]::Open($env:T,[System.IO.FileMode]::Open,[System.IO.FileAccess]::${access},[System.IO.FileShare]$env:S);[Console]::Out.WriteLine('held');[Console]::Out.Flush();[System.Threading.Thread]::Sleep([int]$env:H);$f.Close()`;
  return spawn(PS, ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...env, T: target, S: String(share), H: String(holdMs) } });
}
function nodeHolder(target, holdMs) {
  const code = `const fs=require('fs');const fd=fs.openSync(process.env.T,'r');console.log('held');setTimeout(()=>fs.closeSync(fd),+process.env.H)`;
  return spawn(process.execPath, ["-e", code], { env: { ...env, T: target, H: String(holdMs) } });
}
const held = (child) => new Promise((res, rej) => {
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d; if (out.includes("held")) res(); });
  child.stderr.on("data", (d) => { err += d; });
  child.on("exit", (c) => rej(new Error(`holder exited ${c} before holding: ${err.trim()}`)));
});
const exited = (child) => new Promise((res) => child.exitCode !== null ? res() : child.on("exit", res));

const dir = mkdtempSync(join(tmpdir(), "kyb-621-"));
let n = 0;
async function attempt(label, makeHolder, { holdMs = 3000, retryUntil = 0, mode = 0o600 } = {}) {
  const target = join(dir, `t${++n}.json`);
  writeFileSync(target, "OLD");
  const child = makeHolder(target, holdMs);
  await held(child);
  const t0 = Date.now();
  let first = "ok", tries = 1, okAfterMs = null;
  try { writeAtomic(target, "NEW", { mode }); okAfterMs = 0; }
  catch (e) {
    first = e.code ?? String(e);
    while (Date.now() - t0 < retryUntil) {
      await new Promise((r) => setTimeout(r, 25));
      tries++;
      try { writeAtomic(target, "NEW", { mode }); okAfterMs = Date.now() - t0; break; } catch {}
    }
  }
  const content = readFileSync(target, "utf8");
  const tmpLeft = existsSync(`${target}.tmp`);
  await exited(child);
  console.log(JSON.stringify({ case: label, holdMs, firstAttempt: first, tries, succeededAfterMs: okAfterMs, targetNow: content, tmpLeftBehind: tmpLeft }));
}

// FileShare flags: None=0 Read=1 Write=2 Delete=4
await attempt("node fs.openSync(target,'r') [libuv shares R|W|D]", (t, h) => nodeHolder(t, h));
for (const [name, share] of [["Read", 1], ["ReadWrite", 3], ["Read|Delete", 5], ["ReadWrite|Delete", 7], ["None", 0]]) {
  await attempt(`.NET File.Open Read, FileShare.${name}`, (t, h) => psHolder(t, share, h));
}
// Transient hold, as an indexer or scanner would: does a bounded retry recover, and how fast?
await attempt("TRANSIENT 300ms, FileShare.Read, retry up to 2s", (t, h) => psHolder(t, 1, h), { holdMs: 300, retryUntil: 2000 });
await attempt("TRANSIENT 300ms, FileShare.ReadWrite, retry up to 2s", (t, h) => psHolder(t, 3, h), { holdMs: 300, retryUntil: 2000 });
// No-mode path (store.ts saveState) for the most likely failing share mode.
await attempt("no-mode path, FileShare.Read", (t, h) => psHolder(t, 1, h), { mode: undefined });

// Permanent failure for the 'surfaces to the user' criterion: a read-only target.
{
  const target = join(dir, "readonly.json");
  writeFileSync(target, "OLD");
  await new Promise((r) => spawn("attrib", ["+R", target], { shell: true }).on("exit", r));
  let code = "ok"; try { writeAtomic(target, "NEW", { mode: 0o600 }); } catch (e) { code = e.code; }
  console.log(JSON.stringify({ case: "target has read-only attribute", firstAttempt: code, targetNow: readFileSync(target, "utf8"), tmpLeftBehind: existsSync(`${target}.tmp`) }));
}

// Natural contention: hammer one target with no holder. Defender real-time state printed for context.
{
  const target = join(dir, "hammer.json");
  writeFileSync(target, "0");
  const codes = {}; const N = 3000; const t0 = Date.now();
  for (let i = 1; i <= N; i++) { try { writeAtomic(target, String(i), { mode: 0o600 }); } catch (e) { codes[e.code] = (codes[e.code] ?? 0) + 1; } }
  console.log(JSON.stringify({ case: `hammer ${N} sequential writes, no deliberate holder`, failures: codes, ms: Date.now() - t0, final: readFileSync(target, "utf8") }));
}
