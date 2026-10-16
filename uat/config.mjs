/**
 * KYBER Studio UAT — the only app-specific file in uat/ (besides stories and
 * the Studio verbs at the bottom of harness.mjs).
 *
 * appydave branch only. Not for Ian's main.
 *
 * ISOLATION. Studio has no env var for its data folder, but Chromium's
 * `--user-data-dir` moves Electron's `userData` wholesale (measured on Electron
 * 34.5.8, 2026-10-16): conversations.json, session.bin, local-agents.json and
 * the single-instance lock all follow it. So the harness never opens
 * ~/Library/Application Support/kyber-studio — the folder the installed app
 * and `npm run dev` share.
 *
 * PERSISTENT HOME, on purpose. Signing in is a device-code flow that ends in a
 * browser, which only a person can complete. The home therefore lives at
 * ~/.kyber-studio-uat/ and keeps session.bin between runs: sign in once, then
 * every later run is unattended. Everything else that a story could leave
 * behind is reset at the start of each run (see makeHome).
 */

import { mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExpectationFailed } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');

export const APP = 'kyber-studio';

/** Studio has no test-hooks global; it is driven through its UI and the main inspector. */
export const HOOKS_GLOBAL = null;

/** Not 9222/9229, and not 9333 (scripts/cdp-drive.mjs's port for the dev build). */
export const PORTS = {
  renderer: Number(process.env['UAT_RENDERER_PORT'] ?? 9355),
  main: Number(process.env['UAT_MAIN_PORT'] ?? 9356),
};

export const UAT_ROOT = process.env['KYBER_UAT_HOME'] ?? join(homedir(), '.kyber-studio-uat');
const USER_DATA = join(UAT_ROOT, 'userData');
const SCRATCH_AGENT = join(UAT_ROOT, 'scratch-agent');
export const SHOTS = join(UAT_ROOT, 'shots', new Date().toISOString().replace(/[:.]/g, '-'));

/** The home survives the run (it holds the sign-in). run.mjs reads this. */
export const KEEP_HOME = true;

/** The cloud agent stories 2, 5 and 6 talk to — the only one reachable from Roamy on 2026-10-16. */
const CLOUD_AGENT = process.env['UAT_CLOUD_AGENT'] ?? 'Brandy';

/** What the scheduled-turn story waits for. */
export const SCHEDULED_REPLY = 'SCHEDULED-UAT-OK';

export function makeHome() {
  mkdirSync(USER_DATA, { recursive: true, mode: 0o700 });
  mkdirSync(SCRATCH_AGENT, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  const notes = [];

  // Reset what a previous run could have left behind. session.bin, device-id
  // and control-plane.json are kept: they are the sign-in.
  for (const f of ['conversations.json', 'local-schedule-state.json']) {
    if (existsSync(join(USER_DATA, f))) {
      rmSync(join(USER_DATA, f));
      notes.push(`reset ${f}`);
    }
  }

  // Two local agents: the real kybsite (story 3 talks to it with a no-tools
  // prompt), and a scratch agent whose folder is ours, carrying a schedule at
  // 00:00 so it is due on the first tick after launch (story 4). Keeping the
  // schedule off kybsite means it can never collide with story 3's turn, or
  // with anyone working in kybernesis-site.
  const agents = [
    { id: 'local:kybsite', name: 'kybsite', folder: '/Users/davidcruwys/dev/kybernesis/kybernesis-site', model: 'sonnet' },
    {
      id: 'local:uat-scratch',
      name: 'uat-scratch',
      folder: SCRATCH_AGENT,
      model: 'haiku',
      schedule: { at: '00:00', prompt: `Reply with exactly: ${SCHEDULED_REPLY}. Do not use any tools.` },
    },
  ];
  writeFileSync(join(USER_DATA, 'local-agents.json'), JSON.stringify(agents, null, 2));
  notes.push(`seeded local-agents.json: ${agents.map((a) => a.name).join(', ')}`);
  notes.push(existsSync(join(USER_DATA, 'session.bin')) ? 'signed in: session.bin present' : 'NOT signed in yet: story 1 waits for you to sign in');
  notes.push(`screenshots: ${SHOTS}`);
  return { home: USER_DATA, notes };
}

export function launchService() {
  return null;
}

export async function waitForService() {
  return 0;
}

/** Built output only: `npm run build` first, or you are driving the previous build. */
export function launchApp(home) {
  const bin = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  const child = spawn(
    bin,
    [ROOT, `--user-data-dir=${home}`, `--inspect=${PORTS.main}`, `--remote-debugging-port=${PORTS.renderer}`],
    { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: false },
  );
  const out = [];
  child.stdout.on('data', (d) => out.push(d.toString()));
  child.stderr.on('data', (d) => out.push(d.toString()));
  launched = child;
  return { child, out };
}

/** The app this run spawned — the only process tree the quit story may inspect. */
let launched = null;

export async function resetBetweenStories() {
  /* Stories run in order against one signed-in window; each states the state it starts from. */
}

export function extraVerbs() {
  const arg2 = (a) => {
    const i = String(a).indexOf('~');
    return i === -1 ? [String(a).trim(), ''] : [a.slice(0, i).trim(), a.slice(i + 1).trim()];
  };
  return {
    shot: (h, a) => h.shot(SHOTS, a),
    waitSignedIn: (h, a) => h.waitSignedIn(Number(a || 600)),
    openAgent: (h, a) => h.openAgent(a),
    send: (h, a) => h.sendMessage(a),
    openCloudAgent: (h) => h.openAgent(CLOUD_AGENT),
    expectCloudAgentListed: async (h) => {
      const names = await h.sidebarNames();
      if (!names.some((n) => n.toLowerCase() === CLOUD_AGENT.toLowerCase())) {
        throw new ExpectationFailed(`cloud agent ${CLOUD_AGENT} is not in the sidebar (${names.join(', ')}) — is it hidden on the account?`);
      }
      return h.record('cloudAgent', CLOUD_AGENT, true);
    },
    openSamantha: (h) => h.openAgent(process.env['UAT_SAMANTHA'] ?? 'Samantha'),
    expectVoiceOrb: (h) => h.expectVoiceOrb(),
    openComputerAgent: async (h) => {
      const name = process.env['UAT_COMPUTER_AGENT'];
      if (!name) throw new ExpectationFailed('UAT_COMPUTER_AGENT is not set: no agent reachable from this machine has a computer (see the story PRECONDITION)');
      await h.openAgent(name);
      return h.openPanel();
    },
    expectComputerCard: (h) => h.expectComputerCard(),
    openComputerView: (h) => h.openComputerView(),
    openPanel: (h) => h.openPanel(),
    pressNewConversation: (h) => h.pressButton('New conversation'),
    expectReply: (h, a) => { const [needle, secs] = arg2(a); return h.expectReply(needle, Number(secs || 120)); },
    expectReplyStreamed: (h, a) => h.expectReplyStreamed(Number(a || 120)),
    rememberView: (h, a) => h.rememberView(a),
    expectViewStill: (h, a) => h.expectViewStill(a),
    expectFreshStart: (h) => h.expectFreshStart(),
    openOlderThread: (h) => h.openOlderThread(),
    waitSync: (h, a) => h.wait(Number(a || 35) * 1000),
    waitIdle: (h, a) => h.waitIdle(Number(a || 60)),
    quitAndCheckProcesses: (h) => h.quitAndCheckProcesses(launched.pid),
  };
}

export const LIVE_HOME_NOTE =
  'the live ~/Library/Application Support/kyber-studio was never opened by this run (--user-data-dir points here)';

export const HOME_REPORT_DIRS = ['.'];
