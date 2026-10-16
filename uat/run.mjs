#!/usr/bin/env node
/**
 * The runner. Generic — edit config.mjs, not this file.
 *
 *   node uat/run.mjs                 every story in uat/stories/
 *   node uat/run.mjs 2 4             only stories 2 and 4
 *   node uat/run.mjs --self-test     the deliberately-broken story; MUST fail
 *   UAT_VERBOSE=1 node uat/run.mjs   every action and assertion, raw
 *   UAT_KEEP_HOME=1 node uat/run.mjs keep the isolated home for inspection
 *
 * Stories are MARKDOWN. Adding one is a new file in uat/stories/ and nothing
 * else. Adding a VERB is the only thing that touches code.
 *
 * THE BOUNDARY: this runner never grades how anything looked, sounded or
 * felt. A story needing a human verdict ends in `defer:`, which prints the
 * question and marks the story HUMAN — never PASS. Automate reach, not
 * judgement.
 */

import { readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachRenderer, attachMain } from './cdp.mjs';
import { Harness, ExpectationFailed } from './harness.mjs';
import * as config from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const selfTest = args.includes('--self-test');
const only = args.filter((a) => /^\d+$/.test(a));

// ---------------------------------------------------------------- story file

/** Parse a story markdown file into { meta, expect, surprising, steps }. */
function parseStory(path) {
  const src = readFileSync(path, 'utf8');
  const fm = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(src);
  if (!fm) throw new Error(`${path}: missing frontmatter`);
  const meta = {};
  for (const line of fm[1].split('\n')) {
    const m = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const body = fm[2];
  const grab = (label) => {
    const m = new RegExp(`^${label}:\\s*([\\s\\S]*?)(?=\\n[A-Z]+:|\\n## |$)`, 'm').exec(body);
    return m ? m[1].trim() : null;
  };
  const stepsBlock = /## steps\n([\s\S]*)$/.exec(body);
  const steps = (stepsBlock ? stepsBlock[1] : '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => {
      const m = /^- (\w+)(?::\s*([\s\S]*))?$/.exec(l);
      if (!m) throw new Error(`${path}: cannot parse step ${JSON.stringify(l)}`);
      let arg = m[2] ?? '';
      if (/^".*"$/.test(arg)) arg = JSON.parse(arg);
      return { verb: m[1], arg };
    });
  return { path, meta, expect: grab('EXPECT'), surprising: grab('SURPRISING'), steps };
}

function loadStories() {
  const dir = join(HERE, selfTest ? 'self-test' : 'stories');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => parseStory(join(dir, f)))
    .filter((s) => only.length === 0 || only.includes(String(s.meta.story)));
}

// ------------------------------------------------------------------- verbs
//
// The base vocabulary. App-specific verbs come from config.extraVerbs().

/** Split `a ~ b` into [a, b]; everything after the first ~ belongs to b. */
const split2 = (a) => {
  const i = String(a).indexOf('~');
  return i === -1 ? [String(a).trim(), ''] : [a.slice(0, i).trim(), a.slice(i + 1).trim()];
};

const BASE_VERBS = {
  press: (h, a) => h.pressButton(a),
  type: (h, a) => { const [hint, text] = split2(a); return h.setInput(hint, text); },
  select: (h, a) => h.selectOption(a),
  hook: (h, a) => h.callHook(a),
  wait: (h, a) => h.wait(Number(a)),
  expectVisible: (h, a) => h.expectVisibleContains(a),
  expectScreen: (h, a) => { const [id, text] = split2(a); return h.expectScreenContains(id, text); },
  expectHook: (h, a) => { const [name, text] = split2(a); return h.expectHookContains(name, text); },
  show: async (h) => { await h.visibleText(); },
  showHook: async (h, a) => { await h.readHook(a); },
  /** A recorded observation that is deliberately not pass/fail. */
  note: (h, a) => h.record('FINDING', a),
  /** The escape hatch that keeps the boundary honest. */
  defer: (h, a) => {
    h.record('DEFER', a);
    const e = new Error(a);
    e.name = 'HumanJudgement';
    throw e;
  },
};

const VERBS = { ...BASE_VERBS, ...config.extraVerbs() };

// ---------------------------------------------------------------- teardown

/**
 * Every descendant of `rootPid`, rootPid included, collected breadth-first.
 *
 * Collected BEFORE anything is killed, deliberately: killing a parent
 * re-parents its children to launchd, after which `pgrep -P` can no longer
 * find them and they leak — holding the inspector port and making the next
 * run fail with "address already in use".
 */
function descendantPids(rootPid) {
  const found = [rootPid];
  const queue = [rootPid];
  while (queue.length) {
    const parent = queue.shift();
    let out = '';
    try {
      out = execSync(`pgrep -P ${parent} || true`).toString().trim();
    } catch {
      /* no children */
    }
    for (const line of out.split('\n').filter(Boolean)) {
      const pid = Number(line.trim());
      if (!Number.isFinite(pid) || found.includes(pid)) continue;
      found.push(pid);
      queue.push(pid);
    }
  }
  return found;
}

/**
 * Kill the process tree THIS RUN LAUNCHED, and nothing else.
 *
 * Never a bare `pkill -f Electron` — VS Code, Slack and Loom are Electron too.
 * And the narrower "matches this repo path" is still too wide: it matches the
 * instance the user opened by hand, and killing that destroys the very window
 * they need in order to answer a deferred question.
 *
 * Descendants of our spawned pid are exactly the right set: Electron's GPU,
 * utility and renderer helpers are all children of the main process, and an
 * app the user started themselves is not.
 *
 * SIGKILL, not SIGTERM: graceful teardown of worker threads can take 5-25s,
 * and a `pkill -f <name>` can leave a process hung for tens of minutes with
 * its listening socket closed but client connections still ESTABLISHED, so
 * nothing detects the death.
 */
/**
 * Attach an error listener to a spawned child IMMEDIATELY, and remember what
 * it said.
 *
 * A spawn failure — wrong path, app not built, missing binary — is emitted
 * asynchronously as an 'error' event, and an UNHANDLED one crashes the
 * process outright. That bypasses the finally block below, so the isolated
 * home leaks on disk and the teardown report never prints. Found by running
 * this scaffold with no app present, which is exactly what the first minute
 * of adopting it looks like.
 */
function guard(wrap) {
  if (!wrap?.child) return wrap;
  wrap.spawnError = null;
  wrap.child.on('error', (e) => {
    wrap.spawnError = e;
  });
  return wrap;
}

/** Fail fast and legibly if a child never started. */
async function assertSpawned(wrap, label) {
  await new Promise((r) => setTimeout(r, 300)); // let the error event land
  if (wrap.spawnError) {
    throw new Error(
      `${label} failed to launch: ${wrap.spawnError.message}\n` +
        `  → check the path in config.mjs, and that the app has been BUILT`,
    );
  }
  if (!wrap.child?.pid) throw new Error(`${label} produced no pid`);
}

function killTree(child) {
  if (!child?.pid) return [];
  const killed = [];
  for (const pid of descendantPids(child.pid).reverse()) {
    try {
      process.kill(pid, 'SIGKILL');
      killed.push(pid);
    } catch {
      /* already gone */
    }
  }
  return killed;
}

// -------------------------------------------------------------------- main

const results = [];
const { home, notes } = config.makeHome();
console.log(`isolated home: ${home}`);
for (const n of notes) console.log(`  ${n}`);

const service = guard(config.launchService(home));
if (service) {
  try {
    await assertSpawned(service, 'service');
    console.log(`service: pid ${service.child.pid}, port ${config.PORTS.service}`);
    const seconds = await config.waitForService(home);
    console.log(`  ready in ${seconds}s\n`);
  } catch (err) {
    killTree(service.child);
    rmSync(home, { recursive: true, force: true });
    console.error(`HARNESS ERROR: ${err.message}`);
    console.error(service.out.join('').slice(-2000));
    process.exit(1);
  }
}

const app = guard(config.launchApp(home));
let renderer;
let main;
let harness;

try {
  await assertSpawned(app, 'app');
  console.log(`launching app: pid ${app.child.pid}, --inspect=${config.PORTS.main}, --remote-debugging-port=${config.PORTS.renderer}`);
  main = await attachMain(config.PORTS.main);
  renderer = await attachRenderer(config.PORTS.renderer);
  console.log('  attached: main + renderer');

  // A hooks global is OPTIONAL. An app whose protocol seam is an HTTP/RPC
  // control surface (imagedrip, 2026-08-07) needs no main-process hooks at
  // all — its front doors are already reachable from outside the window.
  // Hard-failing on a missing global would have refused to drive an app with
  // a BETTER seam than the one the scaffold grew up with.
  if (config.HOOKS_GLOBAL) {
    const hooks = await main.evaluate(`Object.keys(globalThis.${config.HOOKS_GLOBAL} || {}).join(",")`);
    console.log(`  ${config.HOOKS_GLOBAL} reachable: ${hooks || '(NONE — is the test-hooks env flag set?)'}`);
    if (!hooks) throw new Error(`${config.HOOKS_GLOBAL} not reachable; the harness cannot proceed`);
  } else {
    console.log('  no hooks global declared — driving through the UI and the app\'s own protocol');
  }

  // Let the renderer mount and connect before the first story.
  await new Promise((r) => setTimeout(r, 4000));

  const stories = loadStories();
  console.log(`\nrunning ${stories.length} ${selfTest ? 'SELF-TEST' : 'story'} file(s)\n`);

  for (const s of stories) {
    harness = new Harness(renderer, main, {
      log: (l) => console.log(l),
      hooksGlobal: config.HOOKS_GLOBAL,
    });
    // Every story starts from quiet shared state. Stories do not clean up
    // after themselves — some deliberately end mid-action so a human can
    // judge the tail.
    await config.resetBetweenStories(harness);
    await new Promise((r) => setTimeout(r, 500));

    console.log(`── Story ${s.meta.story} — ${s.meta.title}`);
    let verdict = 'PASS';
    let detail = '';
    try {
      for (const { verb, arg } of s.steps) {
        const fn = VERBS[verb];
        if (!fn) throw new Error(`unknown verb '${verb}' (vocabulary: ${Object.keys(VERBS).join(', ')})`);
        await fn(harness, arg);
      }
    } catch (err) {
      if (err.name === 'HumanJudgement') {
        verdict = 'HUMAN';
        detail = err.message;
      } else if (err instanceof ExpectationFailed) {
        verdict = 'FAIL';
        detail = err.message;
      } else {
        verdict = 'ERROR';
        detail = err.message;
      }
    }
    if (verdict === 'FAIL' || verdict === 'ERROR') {
      // Report in the plan's language, not as a stack trace.
      console.log(`   ${verdict}: ${detail}`);
      if (s.surprising) console.log(`   SURPRISING (from the plan): ${s.surprising}`);
    } else if (verdict === 'HUMAN') {
      console.log('   HUMAN JUDGEMENT REQUIRED — the harness does not grade this:');
      console.log(`     ${detail}`);
      if (s.expect) console.log(`   EXPECT: ${s.expect}`);
    } else {
      console.log('   PASS');
    }
    results.push({ story: s.meta.story, title: s.meta.title, verdict, detail, raw: harness.raw });
    console.log('');
  }
} catch (err) {
  console.error(`HARNESS ERROR: ${err.message}`);
  results.push({ story: '-', title: 'harness', verdict: 'ERROR', detail: err.message, raw: harness?.raw ?? [] });
} finally {
  renderer?.close();
  main?.close();
  console.log(`\ncleanup: killed app pid(s) ${killTree(app.child).join(', ') || '(none)'} — no bare pkill used`);
  if (service) {
    console.log(`cleanup: killed service pid(s) ${killTree(service.child).join(', ') || '(none)'}`);
  }

  // What the run actually wrote, PRINTED rather than assumed. A run that
  // claims isolation without showing where its writes landed is a run
  // claiming to have checked.
  try {
    console.log(`\nisolated home: ${home}`);
    for (const dir of config.HOME_REPORT_DIRS) {
      const p = join(home, dir);
      const listing = existsSync(p) ? readdirSync(p) : [];
      console.log(`  ${dir}/: ${listing.join(', ') || '(empty)'}`);
    }
    if (config.SHOTS) console.log(`  screenshots: ${config.SHOTS}`);
    console.log(`  ${config.LIVE_HOME_NOTE}`);
    if (config.KEEP_HOME) {
      console.log('  kept: this app\'s home is persistent by design (see config.mjs KEEP_HOME)');
    } else if (process.env['UAT_KEEP_HOME'] === '1') {
      console.log('  UAT_KEEP_HOME=1 — left on disk for inspection');
    } else {
      rmSync(home, { recursive: true, force: true });
      console.log('  removed (UAT_KEEP_HOME=1 to keep it)');
    }
  } catch (err) {
    console.log(`  could not report on the isolated home: ${err.message}`);
  }
}

// ------------------------------------------------------------------ report

console.log('\n════════ UAT RESULT ════════');
const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad('STORY', 7)}${pad('VERDICT', 9)}TITLE`);
for (const r of results) console.log(`${pad(r.story, 7)}${pad(r.verdict, 9)}${r.title}`);

const fails = results.filter((r) => r.verdict === 'FAIL' || r.verdict === 'ERROR');
const humans = results.filter((r) => r.verdict === 'HUMAN');
console.log(
  `\n${results.length} story(s): ${results.filter((r) => r.verdict === 'PASS').length} pass, ` +
    `${fails.length} fail/error, ${humans.length} awaiting judgement`,
);
if (humans.length) {
  console.log('\nYou must rule on these — the harness deliberately does NOT:');
  for (const h of humans) console.log(`  Story ${h.story}: ${h.detail}`);
}
if (process.env['UAT_VERBOSE'] === '1') {
  console.log('\n════════ RAW ════════');
  for (const r of results) {
    console.log(`\n── Story ${r.story} (${r.verdict})`);
    for (const l of r.raw) console.log(l);
  }
}
if (app.out.length && (fails.length || process.env['UAT_VERBOSE'] === '1')) {
  console.log('\n════════ APP STDOUT/STDERR ════════');
  console.log(app.out.join('').split('\n').slice(-25).join('\n'));
}
process.exit(fails.length ? 1 : 0);
