/**
 * The harness vocabulary — app-agnostic base.
 *
 * ## The one rule that shapes everything here
 *
 * **Automate reach, not judgement.** Every action gets the app into a state.
 * No assertion decides whether something SOUNDED right, LOOKED right or FELT
 * right. Stories needing a human verdict end in `defer`, which reports and
 * refuses to grade.
 *
 * ## Why controls are found by their visible text
 *
 * `pressButton('READ')` locates the control by the text a human reads on it,
 * not by a test id bolted on for the harness. It exercises the real control,
 * and it means the app did not have to be modified to be driveable. Where a
 * `data-testid` already exists for the app's own reasons it is used for
 * READING state, never for driving.
 *
 * ## Why input is set the long way round
 *
 * React tracks input values on the DOM node, so assigning `.value` and firing
 * `input` is silently ignored by controlled components. The native setter plus
 * a bubbling event is what React's synthetic system actually observes. This is
 * the standard workaround, not a cleverness.
 *
 * EXTEND THIS FILE with app-specific verbs (multi-step flows, domain actions).
 * Register them in config.mjs `extraVerbs()`. Do not edit cdp.mjs or run.mjs.
 */

/** Escape a string for embedding in a JS expression sent over CDP. */
const q = (s) => JSON.stringify(String(s));

export class Harness {
  constructor(renderer, main, { log, hooksGlobal = '__appTestHooks' } = {}) {
    this.r = renderer;
    this.m = main;
    this.hooksGlobal = hooksGlobal;
    this.log = log ?? (() => {});
    this.raw = [];
  }

  /**
   * Every ACTION must fail loudly.
   *
   * The classic false-confidence failure is an action that silently returned
   * "didn't happen" while the story carried on to assert something unrelated.
   * Assertions get all the design attention; actions are where the silent pass
   * hides. An action that did not do what it says did not happen, and the
   * story stops there.
   */
  mustSucceed(result, what) {
    if (!result || result.ok !== true) {
      throw new ExpectationFailed(`${what} did not happen: ${JSON.stringify(result)}`);
    }
    return result;
  }

  /** Record raw evidence for the report. Every action and assertion lands here. */
  record(kind, detail, value) {
    const line = `    ${kind.padEnd(16)} ${detail}${value === undefined ? '' : ` -> ${JSON.stringify(value)}`}`;
    this.raw.push(line);
    this.log(line);
    return value;
  }

  // ---------------------------------------------------------------- actions

  /**
   * Press a control by the text a human reads on it.
   *
   * Matches case-insensitively, and falls back to a prefix match so that
   * typographic polish (a real ellipsis in "promote…") does not break an
   * otherwise-correct story. Reports every button on screen when it misses,
   * because "button not found" without the candidate list is unactionable.
   */
  async pressButton(label) {
    const v = await this.r.evaluate(`(() => {
      const all = [...document.querySelectorAll('button, [role=button]')];
      const want = ${q(String(label))}.trim().toLowerCase();
      const text = (b) => (b.textContent || '').trim().toLowerCase();
      const btn = all.find(b => text(b) === want) || all.find(b => text(b).startsWith(want));
      if (!btn) return { ok: false, why: ${q(label)} + ' not found',
                         buttons: all.map(b => (b.textContent||'').trim()) };
      if (btn.disabled) return { ok: false, why: ${q(label)} + ' is disabled' };
      btn.click();
      return { ok: true, matched: (btn.textContent||'').trim() };
    })()`);
    this.record('press', label, v);
    return this.mustSucceed(v, `press(${label})`);
  }

  /**
   * Type into the input or textarea whose placeholder contains `hint`.
   *
   * Placeholder rather than name/id because a placeholder is text the user
   * reads — same principle as locating buttons by their label.
   */
  async setInput(hint, value) {
    const v = await this.r.evaluate(`(() => {
      const hint = ${q(String(hint))}.toLowerCase();
      const els = [...document.querySelectorAll('input, textarea')];
      const el = els.find(e => (e.placeholder || '').toLowerCase().includes(hint));
      if (!el) return { ok: false, why: 'no input/textarea with placeholder containing ' + ${q(hint)},
                        placeholders: els.map(e => e.placeholder) };
      if (el.disabled) return { ok: false, why: 'that field is disabled' };
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
      setter.call(el, ${q(String(value))});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, length: el.value.length };
    })()`);
    this.record('type', `${hint} <- ${String(value).length} chars`, v);
    return this.mustSucceed(v, `type(${hint})`);
  }

  /** Choose an option by value or visible text. */
  async selectOption(wanted) {
    const v = await this.r.evaluate(`(() => {
      const want = ${q(String(wanted))};
      for (const sel of document.querySelectorAll('select')) {
        const opt = [...sel.options].find(o => o.value === want || (o.textContent||'').includes(want));
        if (!opt) continue;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(sel, opt.value);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, selected: sel.value };
      }
      return { ok: false, why: want + ' not among any select options',
               options: [...document.querySelectorAll('select')].map(s => [...s.options].map(o => o.value)) };
    })()`);
    this.record('select', wanted, v);
    return this.mustSucceed(v, `select(${wanted})`);
  }

  /**
   * Call a main-process test hook by name.
   *
   * Legitimate ONLY for input the UI genuinely cannot provide — an OS-level
   * hotkey that cannot be synthesized from an agent shell, for instance. Never
   * a shortcut around a control that exists on screen. The hook must be the
   * SAME closure the real control calls; a hook that reimplements the action
   * tests the hook.
   */
  async callHook(name, ...args) {
    if (!this.hooksGlobal) {
      throw new ExpectationFailed(
        `hook(${name}) used but config.HOOKS_GLOBAL is null — this app has no hooks global. ` +
          'Drive it through the UI, or through its own protocol.',
      );
    }
    const v = await this.m.evaluate(`(async () => {
      const h = globalThis.${this.hooksGlobal};
      if (!h) return { ok: false, why: 'no ${this.hooksGlobal} — is the test-hooks env flag set?' };
      const fn = h[${q(name)}];
      if (typeof fn !== 'function') return { ok: false, why: ${q(name)} + ' is not a hook',
                                             available: Object.keys(h) };
      const out = await fn(...${JSON.stringify(args)});
      return { ok: true, returned: out === undefined ? null : out };
    })()`);
    this.record('hook', name, v);
    return this.mustSucceed(v, `hook(${name})`);
  }

  /** Read a hook's value without asserting on it. Returns the parsed value. */
  async readHook(name) {
    const v = await this.m.evaluate(`(async () => {
      const h = globalThis.${this.hooksGlobal};
      const fn = h && h[${q(name)}];
      if (typeof fn !== 'function') return null;
      return JSON.stringify(await fn());
    })()`);
    const parsed = v ? JSON.parse(v) : null;
    return this.record('readHook', name, parsed);
  }

  async wait(ms) {
    await new Promise((r) => setTimeout(r, ms));
    return this.record('wait', `${ms}ms`);
  }

  // ------------------------------------------------------------- assertions

  /** Text of an element carrying a data-testid. Reads what is on screen. */
  async screenText(testid) {
    const v = await this.r.evaluate(
      `(document.querySelector('[data-testid=' + ${q(JSON.stringify(testid))} + ']')||{}).textContent || null`,
    );
    return this.record('screenText', testid, v);
  }

  /** Whole visible body text — the fallback when a thing has no testid. */
  async visibleText() {
    const v = await this.r.evaluate('document.body.innerText');
    this.record('visibleText', `${(v || '').length} chars`);
    return v;
  }

  async expectScreenContains(testid, needle) {
    const text = (await this.screenText(testid)) ?? '';
    if (!text.toLowerCase().includes(String(needle).toLowerCase())) {
      throw new ExpectationFailed(
        `expected [${testid}] to contain ${JSON.stringify(needle)}; it read ${JSON.stringify(text.slice(0, 200))}`,
      );
    }
    return this.record('expectScreen', `${testid} contains ${JSON.stringify(needle)}`, true);
  }

  async expectVisibleContains(needle) {
    const text = (await this.r.evaluate('document.body.innerText')) ?? '';
    if (!text.toLowerCase().includes(String(needle).toLowerCase())) {
      throw new ExpectationFailed(`expected the window to show ${JSON.stringify(needle)}; it did not`);
    }
    return this.record('expectVisible', JSON.stringify(needle), true);
  }

  /**
   * Poll a hook until its JSON-stringified value contains `needle`.
   *
   * The workhorse for "did the app actually do the thing" when the evidence is
   * an internal event log rather than something on screen. Polls, because the
   * work is asynchronous; reports what it DID see on timeout, because
   * "expected X" without "saw Y" is unactionable.
   */
  async expectHookContains(name, needle, { within = 20_000 } = {}) {
    const deadline = Date.now() + within;
    let seen = null;
    while (Date.now() < deadline) {
      seen = await this.m.evaluate(`(async () => {
        const h = globalThis.${this.hooksGlobal};
        const fn = h && h[${q(name)}];
        if (typeof fn !== 'function') return null;
        return JSON.stringify(await fn());
      })()`);
      if (seen && seen.toLowerCase().includes(String(needle).toLowerCase())) {
        return this.record('expectHook', `${name} contains ${JSON.stringify(needle)}`, true);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new ExpectationFailed(
      `expected ${name}() to contain ${JSON.stringify(needle)} within ${within}ms; last saw ${String(seen).slice(0, 400)}`,
    );
  }
}

// ------------------------------------------------------------------ KYBER Studio verbs
//
// Everything below drives Studio the way a person does: rows by the name on
// them, the composer by focus + typed text + Enter, buttons by their label.
// Nothing reads the store; what is asserted is what is on screen.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

Object.assign(Harness.prototype, {
  async shot(dir, name) {
    const { writeFileSync } = await import('node:fs');
    const res = await this.r.send('Page.captureScreenshot', { format: 'png' });
    const path = `${dir}/${name}.png`;
    writeFileSync(path, Buffer.from(res.result.data, 'base64'));
    return this.record('shot', path);
  },

  /** Signing in ends in a browser, so this only waits for a person to finish it. */
  async waitSignedIn(seconds) {
    const deadline = Date.now() + seconds * 1000;
    let said = false;
    while (Date.now() < deadline) {
      const state = await this.r.evaluate(`(() => {
        if (document.querySelector('.sidebar')) return 'in';
        return /Sign in with your Kybernesis account/.test(document.body.innerText) ? 'out' : 'loading';
      })()`);
      if (state === 'in') return this.record('signedIn', 'sidebar present', true);
      if (state === 'out' && !said) {
        said = true;
        this.log('    >>> NOT SIGNED IN — press "Sign in" in the UAT window and approve the code in your browser.');
      }
      await sleep(2000);
    }
    throw new ExpectationFailed(`not signed in within ${seconds}s`);
  },

  /** The names in the sidebar, in order. */
  async sidebarNames() {
    return this.r.evaluate(`[...document.querySelectorAll('.sidebar__list .row__name')].map(e => e.textContent.trim())`);
  },

  async openAgent(name) {
    const v = await this.r.evaluate(`(() => {
      const want = ${JSON.stringify(String(name))}.trim().toLowerCase();
      const names = [...document.querySelectorAll('.sidebar__list .row__name')];
      const hit = names.find(n => n.textContent.trim().toLowerCase() === want);
      if (!hit) return { ok: false, why: 'no sidebar row called ' + want, rows: names.map(n => n.textContent.trim()) };
      let el = hit;
      while (el && !el.onclick && el.parentElement && !el.matches('button,[role=button],.row')) el = el.parentElement;
      el.click();
      return { ok: true };
    })()`);
    this.record('openAgent', name, v);
    this.mustSucceed(v, `openAgent(${name})`);
    // The header names the open agent; wait for it rather than a fixed sleep.
    for (let i = 0; i < 20; i++) {
      const ph = await this.r.evaluate(`(document.querySelector('[contenteditable=true]')?.getAttribute('aria-label') || document.querySelector('[contenteditable=true]')?.dataset.placeholder || '')`);
      if (String(ph).toLowerCase().includes(String(name).toLowerCase())) return this.record('composerFor', ph, true);
      await sleep(250);
    }
    throw new ExpectationFailed(`opened ${name} but the composer never said "Message ${name}"`);
  },

  async agentBubbles() {
    return this.r.evaluate(`[...document.querySelectorAll('.bubble--agent, .bubble--assistant')].map(b => b.innerText.trim())`);
  },

  async userBubbles() {
    return this.r.evaluate(`[...document.querySelectorAll('.bubble--user')].map(b => b.innerText.trim())`);
  },

  /** Focus the composer, type, press Enter — then prove the message landed. */
  async sendMessage(text) {
    this._agentBefore = (await this.agentBubbles()).length;
    const focused = await this.r.evaluate(`(() => { const c = document.querySelector('[contenteditable=true]'); if (!c) return false; c.focus(); return true; })()`);
    if (!focused) throw new ExpectationFailed('no composer on screen');
    await this.r.send('Input.insertText', { text });
    for (const type of ['keyDown', 'keyUp']) {
      await this.r.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    }
    // Bubbles render markdown, so `code` loses its backticks on screen.
    const plain = (s) => s.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
    const want = plain(text).slice(0, 40);
    for (let i = 0; i < 20; i++) {
      const users = await this.userBubbles();
      if (users.some((u) => plain(u).includes(want))) return this.record('send', text.slice(0, 60), true);
      await sleep(250);
    }
    throw new ExpectationFailed(`sent "${text.slice(0, 40)}…" but no user bubble with it appeared`);
  },

  /** A NEW agent bubble containing `needle`. */
  async expectReply(needle, seconds) {
    const deadline = Date.now() + seconds * 1000;
    let last = [];
    while (Date.now() < deadline) {
      last = await this.agentBubbles();
      const fresh = last.slice(this._agentBefore ?? 0);
      if (fresh.some((b) => b.toLowerCase().includes(String(needle).toLowerCase()))) {
        return this.record('reply', `contains ${JSON.stringify(needle)}`, true);
      }
      await sleep(1000);
    }
    const visible = (await this.r.evaluate('document.body.innerText')).slice(-600);
    throw new ExpectationFailed(`no reply containing ${JSON.stringify(needle)} within ${seconds}s; agent bubbles: ${JSON.stringify(last.slice(-2))}; screen tail: ${JSON.stringify(visible)}`);
  },

  /**
   * A non-empty reply arrives. Whether it visibly GREW (streamed) is sampled
   * every 300 ms and recorded as a finding — a fast model can land whole
   * between samples, so a missed growth is not a failure.
   */
  async expectReplyStreamed(seconds) {
    const deadline = Date.now() + seconds * 1000;
    const lengths = [];
    let settledAt = 0;
    while (Date.now() < deadline) {
      const fresh = (await this.agentBubbles()).slice(this._agentBefore ?? 0);
      const len = fresh.join('').length;
      if (len > 0 && lengths[lengths.length - 1] !== len) { lengths.push(len); settledAt = Date.now(); }
      const busy = await this.r.evaluate(`Boolean(document.querySelector('.activity'))`);
      if (len > 0 && !busy && Date.now() - settledAt > 2000) {
        this.record('FINDING', `reply length samples ${JSON.stringify(lengths)} — ${lengths.length > 1 ? 'grew while streaming' : 'arrived in one piece between samples'}`);
        return this.record('reply', `${len} chars`, true);
      }
      await sleep(300);
    }
    throw new ExpectationFailed(`no complete reply within ${seconds}s (samples ${JSON.stringify(lengths)})`);
  },

  /** The turn has fully settled: no activity line on screen for 2 s. */
  async waitIdle(seconds) {
    const deadline = Date.now() + seconds * 1000;
    let quietSince = 0;
    while (Date.now() < deadline) {
      const busy = await this.r.evaluate(`Boolean(document.querySelector('.activity'))`);
      if (busy) quietSince = 0;
      else if (!quietSince) quietSince = Date.now();
      else if (Date.now() - quietSince > 2000) return this.record('idle', 'no activity for 2 s', true);
      await sleep(250);
    }
    throw new ExpectationFailed(`the agent was still busy after ${seconds}s`);
  },

  async conversationText() {
    return this.r.evaluate(`[...document.querySelectorAll('.bubble, .empty')].map(b => b.innerText.trim()).join('\\n---\\n')`);
  },

  async rememberView(key) {
    this._views = this._views ?? {};
    this._views[key] = await this.conversationText();
    return this.record('remember', `${key}: ${this._views[key].length} chars`);
  },

  async expectViewStill(key) {
    const now = await this.conversationText();
    const then = this._views?.[key];
    if (then === undefined) throw new Error(`nothing remembered as ${key}`);
    if (now !== then) {
      throw new ExpectationFailed(`the view changed since "${key}". Then: ${JSON.stringify(then.slice(-300))} Now: ${JSON.stringify(now.slice(-300))}`);
    }
    return this.record('viewStill', key, true);
  },

  async expectFreshStart() {
    const text = await this.conversationText();
    const bubbles = await this.r.evaluate(`document.querySelectorAll('.bubble').length`);
    if (!/Fresh start/.test(text) || bubbles > 0) {
      throw new ExpectationFailed(`expected an empty view with the Fresh start hint; saw ${bubbles} bubble(s): ${JSON.stringify(text.slice(0, 300))}`);
    }
    return this.record('freshStart', 'empty view + hint', true);
  },

  async openPanel() {
    const v = await this.r.evaluate(`(() => {
      if (document.querySelector('.panel__body')) return { ok: true, already: true };
      const b = document.querySelector('[aria-label="Agent panel"], [title="Agent panel"]');
      if (!b) return { ok: false, why: 'no Agent panel button' };
      b.click();
      return { ok: true };
    })()`);
    this.record('openPanel', '', v);
    return this.mustSucceed(v, 'open the agent panel');
  },

  /** Agent panel → Conversations → a thread that is not the current one. */
  async openOlderThread() {
    await this.openPanel();
    await sleep(500);
    // The overview row reads "Show conversations" and says "Loading…" until the
    // agent answers GET /kyb/sessions; an agent without that route never does.
    const row = await this.r.evaluate(`(() => {
      const r = [...document.querySelectorAll('.panel__body *')].find(e => e.children.length === 0 && e.textContent.trim() === 'Show conversations');
      if (!r) return { ok: false, why: 'no "Show conversations" row in the agent panel' };
      const detail = r.parentElement?.parentElement?.innerText ?? '';
      (r.closest('button,[role=button],.row') || r).click();
      return { ok: true, detail };
    })()`);
    this.record('showConversations', '', row);
    this.mustSucceed(row, 'open the conversation list');
    for (let i = 0; i < 40; i++) {
      const v = await this.r.evaluate(`(() => {
        const body = document.querySelector('.panel__body');
        if (!body) return { ok: false, why: 'no panel body' };
        if (/Loading…/.test(body.innerText)) return { ok: false, wait: true };
        const rows = [...body.querySelectorAll('.row, [role=button], button')].filter(r => !/New conversation/.test(r.innerText));
        const pick = rows.find(r => !r.className.includes('active') && !r.getAttribute('aria-current'));
        if (!pick) return { ok: false, why: 'no other thread to open', rows: rows.map(r => r.innerText.slice(0, 60)) };
        const title = pick.innerText.split('\\n')[0];
        pick.click();
        return { ok: true, title };
      })()`);
      if (v?.wait) { await sleep(500); continue; }
      this.record('openThread', v?.title ?? '', v);
      return this.mustSucceed(v, 'open an older thread');
    }
    throw new ExpectationFailed('the conversation list never finished loading');
  },

  /** The composer's voice control only renders when the agent's voice manifest says enabled. */
  async expectVoiceOrb() {
    for (let i = 0; i < 60; i++) {
      const t = await this.r.evaluate(`(document.querySelector('button[title^="Talk to "][title$=" by voice"]') || {}).title || null`);
      if (t) return this.record('voiceControl', t, true);
      await sleep(250);
    }
    throw new ExpectationFailed('no "Talk to … by voice" control within 15 s — the voice manifest is not enabled, or the agent did not answer it');
  },

  async expectComputerCard() {
    for (let i = 0; i < 60; i++) {
      const label = await this.r.evaluate(`(document.querySelector('.computer__screen') || {}).getAttribute?.('aria-label') ?? null`);
      if (label) return this.record('computerCard', label, true);
      await sleep(250);
    }
    throw new ExpectationFailed('no live Computer card in the agent panel within 15 s — the agent reports no computer');
  },

  async openComputerView() {
    const v = await this.r.evaluate(`(() => { const s = document.querySelector('.computer__screen'); if (!s) return { ok: false, why: 'no computer card' }; s.click(); return { ok: true }; })()`);
    this.record('openComputer', '', v);
    this.mustSucceed(v, 'open the computer view');
    for (let i = 0; i < 40; i++) {
      if (await this.r.evaluate(`Boolean(document.querySelector('.computer-view'))`)) return this.record('computerView', 'open', true);
      await sleep(250);
    }
    throw new ExpectationFailed('pressed the computer card but the full view never opened');
  },

  /**
   * Quit as the app quits itself, then check with ps that nothing the app
   * started is still alive. `app.quit()` is the closure the Quit menu item
   * (role: quit) calls; this does NOT prove macOS delivers ⌘Q.
   */
  async quitAndCheckProcesses(appPid) {
    const { execSync } = await import('node:child_process');
    const tree = [appPid];
    for (let i = 0; i < tree.length; i++) {
      const kids = execSync(`pgrep -P ${tree[i]} || true`).toString().trim().split('\n').filter(Boolean).map(Number);
      for (const k of kids) if (!tree.includes(k)) tree.push(k);
    }
    const describe = (pids) => pids.length ? execSync(`ps -o pid=,command= -p ${pids.join(',')} || true`).toString().trim() : '';
    const claudeBefore = describe(tree).split('\n').filter((l) => /\bclaude\b/.test(l) && !/Electron|Helper/.test(l));
    this.record('before quit', `${tree.length} pids in the app's tree; claude turns: ${claudeBefore.length}`, claudeBefore);
    const res = await this.m.send('Runtime.evaluate', { expression: `require('electron').app.quit(); 'quitting'`, includeCommandLineAPI: true, returnByValue: true });
    this.record('app.quit()', '', res.result?.result?.value ?? res.result?.exceptionDetails?.text);
    // An attached --inspect client holds Node open at exit ("Waiting for the
    // debugger to disconnect…"), which would read as the app refusing to quit.
    this.m.close();
    const deadline = Date.now() + 15_000;
    let alive = tree;
    while (Date.now() < deadline) {
      alive = tree.filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
      if (alive.length === 0) break;
      await sleep(500);
    }
    const left = describe(alive);
    this.record('after quit', `${alive.length} of ${tree.length} still running`, left || null);
    if (claudeBefore.length === 0) this.record('FINDING', 'no local turn was running at quit, so this only proves the app itself exits');
    if (alive.length) throw new ExpectationFailed(`still running 15 s after quit:\n${left}`);
    return true;
  },
});

/** A failed expectation. Distinct from a crash: the run continues to the next story. */
export class ExpectationFailed extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExpectationFailed';
  }
}
