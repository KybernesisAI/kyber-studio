import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

/**
 * The Plugins panel, MOUNTED and DRIVEN.
 *
 * Rounds 3 to 6 each found the same defect wearing a different hat: a damaged
 * `local-mcp.json` left the panel useless with no way out, and the suite stayed
 * green. Each round the fix moved the decision one level further from the
 * component — into `mcpPanel.ts`, then the fold, then the way-in function — and
 * each time the next reviewer put a condition in front of whatever had just
 * been pinned. Round 6's reviewer named the pattern: a component will always
 * contain call sites, so the next indirection buys one round. What was missing
 * was a test that RENDERS the component.
 *
 * So this file renders it. Not `renderToStaticMarkup`, which runs neither
 * `useEffect` nor `onClick` and would have missed both of round 6's mutations:
 * jsdom, `react-dom/client`, and `act()`, driving the real exported `Plugins`
 * through the real store with a fake preload bridge on `window`.
 *
 * WHAT THIS PINS, stated as user-visible facts rather than as source text:
 *
 *  - a damaged config renders the error state, the path, and a recovery button
 *  - that button is ENABLED. `disabled` on it is one word, typechecks under both
 *    tsconfigs, builds, and left the rest of the suite at 304/304 — the escape
 *    hatch on screen and unpressable
 *  - pressing it issues ONE write, carrying `onUnreadableConfig: "quarantine"`,
 *    and the panel then leaves the damaged state; a REFUSED write says so and
 *    keeps the way out on screen
 *  - the local Add button is out of service over a damaged config and in service
 *    over a readable one, and the REMOTE Add button is unaffected by either
 *  - an Add form already open is closed when the config goes unreadable under it,
 *    rather than going on collecting a name, a command and secrets
 *  - a mounted panel performs a load — including when `window.studio` is absent,
 *    where it states the reason instead of loading for ever
 *  - the search box filters the local list, and a search matching nothing shows
 *    the empty state rather than the full list
 *
 * AND TWO THINGS THAT ARE COVERED AS A CLASS RATHER THAN AS EXAMPLES, because
 * round 7 blocked on both — each of the four previous rounds fixed the instance
 * it was handed and the next round found the same defect one state along.
 *
 *  - THE AFFORDANCE CENSUS. Every button the panel body renders in every state
 *    THIS FILE LISTS, with whether it can actually be PRESSED.
 *
 *    Read that scope literally, because review round 8 found both edges of it.
 *    The census is as wide as its STATES list and no wider, and as wide as its
 *    FIXTURES can reach and no wider — every fixture here was `enabled: true`
 *    until round 8, so the row menu rendered "Turn off" in every row and
 *    "Turn on" in none, and `disabled={!s.enabled}` on Remove was green. And it
 *    measures ONE axis, `disabled`. It does not press what it enumerates, so a
 *    guard that leaves a button pressable and makes the press do nothing is
 *    invisible to it — measured, KYB-597. Round 7's first
 *    blocking finding was that `disabled` on the recovery button was pinned in
 *    the fresh damaged state and nowhere else, so `disabled={!!saveError}` on it
 *    was green: a user whose quarantine was refused once saw the escape hatch
 *    and a second press that wrote nothing. Presence is not pressability, and
 *    pressability in ONE state is not pressability. The census asserts the whole
 *    button list per state by exact equality, so an affordance added to any
 *    state it lists — or one that changes its `disabled` in one — fails until it
 *    is described. States it does not list are the limit, and the guard below is
 *    what makes those hard to add. A test below reads the `McpPanelView` union
 *    out of `mcpPanel.ts` and fails if a `kind` exists with no census row, which
 *    is what makes an N+1th STATE hard to add without a test.
 *  - THE BRIDGE FAILING. The fake bridge can reject OR hang on every method it
 *    exposes, not just the one a reviewer happened to ask about, and every
 *    method has a stated expected behaviour in `WHEN_IT_FAILS` with a test that
 *    drives it. Two of the three are driven as rejections; `connectors` is
 *    driven as a call that never returns, and the test says at length why a
 *    rejecting one cannot be asserted from a mounted panel today. Round 7's
 *    second blocking finding was that swapping the two awaits in `refresh()` —
 *    `connectors()` first, `loadMcpPanel` second — was green, because no bridge
 *    in this file had ever failed at anything. MEASURED 25 Sep: with that swap
 *    applied and a remote call that does not return, the whole LOCAL half goes
 *    to a permanent `Loading…`, damaged screen and way out gone.
 *
 * WHAT IT DOES NOT PIN, and this list is the honest part. The Apps, Marketplace
 * and Yours tabs are never opened; `AppsTab` mounts only because the panel opens
 * on it. Nothing here SUBMITS either Add form, and nothing drives Remove, Turn
 * off, Connect or Check to their effects — the census reaches those buttons and
 * says they are pressable, which is not the same as saying what pressing them
 * does. The remote server list is always empty, so no remote ROW is ever
 * rendered, and the buttons one carries — the primary slot, which is a four-way
 * branch between a spinner, Check and two kinds of Connect, plus Change/Share
 * and Remove — are all outside the census.
 *
 * ADDED AFTER ROUND 8, which found each of these by making a mutation stay
 * green rather than by reading:
 *
 *  - The LOCAL row's primary slot is a three-way too — `<Spinner/>` while
 *    `checking`, "Ready" once `result[id].ok`, and the `Connect` button
 *    otherwise. Only the `Connect` arm is ever censused, because no fixture sets
 *    `checking` or seeds `result`. The other two arms are not buttons, so a
 *    change that renders one of them instead of `Connect` removes an affordance
 *    the census WOULD see; a change WITHIN either is not covered.
 *  - EFFICACY is not a class here. The recovery button is pressed and its write
 *    asserted in three states; the census enumerates four. A guard in front of
 *    the write keyed on a flag that is false in those three — `if (!loadError)`
 *    is the measured one — is green. KYB-597 carries the measurement and the
 *    fix. Do not read the census as protection against it.
 * Styling, layout and the modal's own open/close are not looked at. A regression
 * in any of those is NOT covered here.
 *
 * ONE TRAP, AND IT IS THE MOST EXPENSIVE THING IN THIS FILE. Never let a jsdom
 * node be the `actual` of an assertion. Write
 *
 *     assert.ok(!node)          // right
 *     assert.equal(node, null)  // WRONG — this is the form that blows up
 *
 * An earlier version of this comment recommended those the wrong way round. On
 * failure the runner serialises `actual` for the report, and a React-attached
 * element drags a live fibre graph behind it.
 *
 * MEASURED on this box, 25 Sep, on the SAME failing assertion in this suite
 * written both ways:
 *
 *     assert.equal(node, null)    772 s   5,891 MB peak RSS   0 bytes of output
 *     assert.ok(!node)              2 s     274 MB            1,563-byte failure
 *
 * (ROUND 7, quoted from notes and NOT re-run since — deliberately: reproducing
 * the first one costs twelve minutes and six gigabytes, and the box does not
 * recover on its own. Round 8's reviewer independently declined to reproduce it
 * for the same reason, and was right to.)
 *
 * Corroborated separately against a BARE React `<button>` alone in a root —
 * which is as far as it is safe to reproduce this deliberately. Re-measured on
 * this box on 25 Sep, both forms against the same rendered node:
 *
 *     assert.ok(!node)             63 bytes of message,     4 ms
 *     assert.equal(node, null)     17,012 bytes,            6 ms
 *
 * (Measured while preparing the round-7 FIXES, i.e. for commit `0cff7ee`. Round
 * 8's reviewer then re-ran the same probe independently and got 63 and 17,244 —
 * which is the point of the next paragraph.)
 *
 * Treat those two numbers as evidence of the DIRECTION and nothing more. They
 * are sensitive to what the element is: an earlier run of the same probe, on a
 * button with different markup, gave 30 and 22,221 — so do not expect either
 * figure to reproduce exactly. What does reproduce is the shape. The gap between
 * ~17 KB for a lone button and 5,891 MB for one inside the mounted panel is the
 * size of the fibre graph behind the node, and nothing at the call site shows
 * you which of the two you have.
 *
 * Two things that look as though they would bound that, and DO NOT:
 *
 *  - `--max-old-space-size` does not bound it. The 772 s probe ran under a
 *    1024 MB cap and still reached 5,891 MB RSS. The cap in the `test` script is
 *    worth keeping against ordinary runaway allocation, but it is not a limit on
 *    this and must not be described as one.
 *  - A parent-level `timeout` does not stop it. That probe ran under
 *    `timeout -s KILL 90` and lasted 772 s, because the runner's per-file CHILD
 *    survives a signal sent only to the parent. Kill the process GROUP.
 *
 * So nothing in the toolchain holds this. The discipline does: every assertion
 * in this file takes PLAIN DATA as its `actual` — a boolean, a string, or the
 * census objects below — and never a node. That is why the census returns
 * `{ label, pressable }` records rather than the elements it found them on.
 *
 * It also reads exactly like the hang a mutant produces, which is the second
 * cost: an earlier, smaller instance was measured at 134 s in round 7 and
 * reported the FILE as failed rather than the test that did it.
 */

// ── the DOM, installed before react-dom is imported ─────────────────────────
//
// react-dom reads globals when its module body runs, so jsdom goes in first and
// the imports below are dynamic for that reason alone.

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
for (const name of [
  "HTMLElement",
  "HTMLInputElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "CustomEvent",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
]) {
  globalThis[name] = dom.window[name];
}
// React refuses to run `act` outside a test environment, and warns loudly about
// updates outside one. Both are what we want here.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement, Profiler } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Plugins } = await import("../src/renderer/src/components/Plugins.tsx");
const { useStore } = await import("@/lib/store");
// Imported rather than retyped: a test that spells the message out itself stops
// describing what the panel says the moment someone edits the constant.
const { NO_ANSWER_MESSAGE } = await import("@/lib/mcpPanel");

after(() => dom.window.close());

/**
 * Rejections that ESCAPE the component, recorded instead of fatal.
 *
 * `useEffect(() => { void refresh(); }, [agent])` discards whatever `refresh()`
 * rejects with, so a rejecting bridge method reaches process-level
 * `unhandledRejection` — which, with no listener, aborts the entire runner and
 * takes the other tests in this file with it. Recording them keeps the file
 * alive AND turns "what escapes" into something the tests below state
 * deliberately rather than discover.
 *
 * As it stands NOTHING in this file escapes, and the last test in the file is
 * the receipt for that. The machinery is here because the absence is a fact
 * worth holding, not because a test depends on it.
 *
 * PRE-EXISTING and NOT fixed by KYB-590: a rejecting `connectors()` IS a silent
 * failure at head. The rejection is dropped, the remote half stays empty, and
 * nothing on screen says why — which is also why no test here can reject on it,
 * since the escape fails whichever test happens to be running. Being filed
 * separately; see the `connectors` test below.
 */
const escaped = [];
process.on("unhandledRejection", (reason) => escaped.push(reason));

/** Drain and describe what escaped since the last drain. */
function takeEscaped() {
  return escaped.splice(0).map((e) => (e instanceof Error ? e.message : String(e)));
}

// ── driving it ──────────────────────────────────────────────────────────────

// ── runaway guard ───────────────────────────────────────────────────────────
//
// An effect that sets state on an unstable dependency renders for ever, and
// nothing in the runner stops it:
//
//  - `--test-timeout` cannot interrupt it. The loop is synchronous allocation,
//    so no timer is ever allowed to fire. Measured in round 7: 6.0 GB in 103
//    seconds, which takes the whole VM down rather than failing a test.
//  - `--max-old-space-size=512` in the `test` script does not bound it either,
//    and is not there as a defence against it. Keep the cap — it is cheap and it
//    helps against ordinary allocation — but do not read it as a ceiling: a
//    probe capped at 1024 MB was measured on 25 Sep reaching 5,891 MB RSS.
//
//
// Counting commits is the only hook inside the loop. The soft limit is asserted
// after mounting, after opening the tab, and after EVERY click and keystroke the
// helpers below drive — the counter is reset before each, so the budget is per
// interaction and not per test. A throw there is a clean failure.
//
// It does not cover renders that arrive LATER, from an awaited answer settling
// after the assertion has run. The hard ceiling is what covers those, and it
// throws inside the commit itself because by then nothing else will stop it.
const RENDER_LIMIT = 50;
const HARD_CEILING = 400;
let commits = 0;

function countCommit() {
  commits += 1;
  if (commits > HARD_CEILING) {
    throw new Error(
      `render loop: ${commits} commits — breaking out inside the commit phase`,
    );
  }
}

function resetCommits() {
  commits = 0;
}

function assertSettled(what) {
  assert.ok(
    commits <= RENDER_LIMIT,
    `render loop: ${what} committed ${commits} times (limit ${RENDER_LIMIT}). ` +
      "An effect is setting state on a dependency whose identity changes every render.",
  );
}

const AGENT = "agent-under-test";

/** Let effects, awaited answers and the resulting renders finish. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  });
}

/**
 * Mount the real `Plugins` with `studio` as the preload bridge, and open the
 * MCP tab by CLICKING it — the panel starts on Apps, and a test that reached
 * past the tab would not be driving the same component the user does.
 */
async function mount(studio) {
  if (studio === undefined) delete dom.window.studio;
  else dom.window.studio = studio;

  useStore.setState({
    pluginsOpen: true,
    activeAgentId: AGENT,
    // `loadCatalog` returns early without an agent URL, so the marketplace
    // fetch stays out of the way of what this file is about.
    agents: [],
    details: {},
    catalog: {},
    manageError: null,
    installing: null,
  });

  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);

  resetCommits();
  await act(async () => {
    root.render(
      createElement(Profiler, { id: "plugins", onRender: countCommit }, createElement(Plugins)),
    );
  });
  await settle();
  assertSettled("mounting the panel");

  const tab = button(host, "MCP servers");
  assert.ok(tab, "the MCP tab is not on screen at all");
  resetCommits();
  await click(tab);
  await settle();
  assertSettled("opening the MCP tab");

  return {
    host,
    text: () => host.textContent ?? "",
    unmount: () => act(() => root.unmount()).then(() => host.remove()),
  };
}

function button(root, label) {
  return [...root.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(label));
}

async function click(element) {
  resetCommits();
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  assertSettled("a click");
}

/**
 * Type into a CONTROLLED input. Setting `.value` alone is invisible to React —
 * it tracks the previous value on the node and suppresses the change — so the
 * native setter goes through the prototype descriptor.
 */
async function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    "value",
  ).set;
  setter.call(input, value);
  resetCommits();
  await act(async () => {
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  assertSettled("a keystroke");
}

const DAMAGED_PATH = "/home/user/.config/kyber-studio/local-mcp.json";
const RECOVER = "Move it aside and start again";

const plaud = {
  id: "plaud",
  name: "Plaud",
  command: "npx",
  args: ["-y", "@plaud-ai/mcp@latest"],
  enabled: true,
};
const arcana = {
  id: "arcana",
  name: "Arcana",
  command: "node",
  args: ["arcana.js"],
  enabled: true,
};
// TURNED OFF, and here for exactly that reason. Review round 8 found that every
// fixture in this file was `enabled: true`, so the row menu rendered "Turn off"
// in every census row and "Turn on" in none — and `disabled={!s.enabled}` on
// Remove was green at 335/334/0 with both typechecks clean. You could not remove
// a server you had turned off, and nothing here could see it. A census is only
// as wide as the states its fixtures can reach.
const dormant = {
  id: "dormant",
  name: "Dormant",
  command: "node",
  args: ["dormant.js"],
  enabled: false,
};

/**
 * Every method the fake bridge exposes to the panel.
 *
 * Named as data because two things below are driven from it: the failure table,
 * which requires a stated expected behaviour for each, and a test that fails if
 * this list and the object `bridge()` builds ever disagree.
 *
 * WHAT THOSE TWO GUARDS ACTUALLY COVER, corrected after round 8. Both compare
 * things in THIS FILE to each other — the fake against this list, and
 * `WHEN_IT_FAILS` against this list. Neither compares anything to what the
 * COMPONENT calls. An earlier version of this comment said "a method with no
 * stated failure behaviour cannot be added quietly", and that was false: it is
 * a method added to the FAKE that cannot be added quietly.
 *
 * Eight methods `Plugins.tsx` calls are in neither table and fail nothing today
 * — `addCustomConnector`, `connectMcpServer`, `connectService`,
 * `disconnectService`, `openExternal`, `startMcpSignIn`, `testMcpServer`,
 * `testRemoteMcp`. A ninth costs nothing to add. (`mcpServers` and
 * `saveMcpServers` are absent from that list because the panel reaches them
 * through `mcpPanel.ts` rather than naming them here.)
 *
 * Closing that would mean deriving the list from the component's source, which
 * is a different kind of test from the rest of this file — it reads source text
 * rather than driving behaviour, and a mutation only a text-scan can catch is
 * one this file's own rule says not to count as caught. Stated, not fixed.
 */
const BRIDGE_METHODS = ["connectors", "mcpServers", "saveMcpServers"];

/** What a rejecting bridge method throws. Asserted on, so it is a constant. */
const BRIDGE_FAILURE = "the bridge refused";

/**
 * A bridge that records what the panel asked it to do, and can FAIL AT ANY OF
 * IT.
 *
 * `damage()` flips it AFTER mounting, which is how the config-goes-bad-while-
 * you-are-typing case below is reached: the panel re-reads on a change of
 * agent, and that is a thing a user does.
 *
 * `rejects` and `pending` are the round 7 addition, and the reason is the
 * finding rather than the fix. Every bridge in this file used to answer
 * everything, always, so `refresh()` awaiting `connectors()` BEFORE
 * `loadMcpPanel` was a free mutation: the remote call rejects, the rejection
 * propagates out of `refresh()` before the local half is ever loaded, `servers`
 * stays `null`, and the panel sits on `Loading…` with no error and no way out.
 * Green across the whole suite, because nothing here could fail at anything.
 *
 * They are applied by WRAPPING every method uniformly rather than by patching
 * one of them, so a method added to this bridge inherits the ability to fail
 * without anyone remembering to give it one.
 *
 *   rejects  — these methods throw instead of answering
 *   pending  — these methods return a promise that never settles, which is how
 *              the panel is held in its `loading` state long enough to take a
 *              census of it, and how a dependency that hangs rather than fails
 *              is driven
 */
function bridge({ servers = [], damaged = false, onSave, rejects = [], pending = [] } = {}) {
  const saves = [];
  const loads = [];
  const connectorCalls = [];
  let bad = damaged;

  const answers = {
    connectors: async () => {
      connectorCalls.push(Date.now());
      return { configured: true, connectors: [] };
    },
    mcpServers: async () => {
      loads.push(Date.now());
      return bad ? { ok: false, path: DAMAGED_PATH } : { ok: true, servers };
    },
    saveMcpServers: async (next, options) => {
      saves.push({ servers: next, options });
      return onSave ? onSave(next, options) : { ok: true, servers: next };
    },
  };

  // Recorded in the WRAPPER, before the outcome is decided: a method that
  // rejects still proves the panel asked, and `saves` below would not, because
  // a rejecting `saveMcpServers` never reaches the line that appends to it.
  const calls = [];

  const api = {};
  for (const [name, answer] of Object.entries(answers)) {
    api[name] = async (...args) => {
      calls.push(name);
      if (pending.includes(name)) return new Promise(() => {});
      if (rejects.includes(name)) throw new Error(`${name}: ${BRIDGE_FAILURE}`);
      return answer(...args);
    };
  }

  return {
    saves,
    loads,
    calls,
    connectorCalls,
    damage: () => {
      bad = true;
    },
    api,
  };
}

test("DOM: the fake bridge exposes exactly the methods the failure table covers", () => {
  // The guard on the two tables above. A method added to `bridge()` and not to
  // `BRIDGE_METHODS` fails here; a method in `BRIDGE_METHODS` with no stated
  // expected behaviour fails in the failure table's own guard further down.
  assert.deepEqual(Object.keys(bridge().api).sort(), [...BRIDGE_METHODS].sort());
});

/** Switch agent, which is what makes the panel re-read the config. */
async function switchAgent(id) {
  await act(async () => {
    useStore.setState({ activeAgentId: id });
  });
  await settle();
}

// ── a damaged config: the state, the way out, and whether it can be pressed ──

test("DOM: a damaged config renders the error, the path and a way out", async () => {
  const b = bridge({ damaged: true });
  const panel = await mount(b.api);
  try {
    assert.equal(b.loads.length >= 1, true, "the mounted panel never asked for the servers");
    assert.ok(
      !panel.text().includes("Loading…"),
      "the panel is still loading after an answer arrived",
    );
    assert.match(panel.text(), /damaged and can’t be read/, "the honest error state is not shown");
    assert.ok(panel.text().includes(DAMAGED_PATH), "the path to repair by hand is not shown");
    assert.ok(
      !panel.text().includes("Nothing running here yet"),
      "a config the app cannot read is being reported as an empty list",
    );
    assert.ok(button(panel.host, RECOVER), "there is no way out of the damaged state");
  } finally {
    await panel.unmount();
  }
});

test("DOM: the way out can actually be pressed", async () => {
  // PAUL'S DOOR, round 7. Adding `disabled` to this button is one word; it
  // typechecks under both tsconfigs, builds, and left the rest of the suite at
  // 304/304. The user then sees the error, the path, and an escape hatch that
  // does nothing. The source check in mcp-panel-state.test.mjs greps for the
  // quarantine option, which is INSIDE the onClick the word neuters — it was
  // aimed one line to the left of the defect.
  const b = bridge({ damaged: true });
  const panel = await mount(b.api);
  try {
    const recover = button(panel.host, RECOVER);
    assert.ok(recover, "there is no way out of the damaged state");
    assert.equal(recover.disabled, false, "the only way out of a damaged config is disabled");
    assert.equal(
      recover.hasAttribute("disabled"),
      false,
      "the only way out of a damaged config is disabled",
    );
  } finally {
    await panel.unmount();
  }
});

test("DOM: pressing the way out writes, and asks for the quarantine", async () => {
  // ROUND 6'S FIRST CONDITION. `if (!unreadable) await saveMcpPanel(...)` in
  // `save()` is false exactly when this button is on screen, so the press
  // performed no write, set no error and changed no state — and the suite
  // stayed at 304/304, because the grep it is aimed at is satisfied by the call
  // still being written in the file.
  const b = bridge({ damaged: true });
  const panel = await mount(b.api);
  try {
    await click(button(panel.host, RECOVER));
    await settle();

    assert.equal(b.saves.length, 1, "pressing the way out issued no write");
    assert.deepEqual(b.saves[0].servers, [], "the recovery wrote something other than an empty list");
    assert.deepEqual(
      b.saves[0].options,
      { onUnreadableConfig: "quarantine" },
      "the write did not ask for the damaged file to be moved aside",
    );

    // And the panel LEFT the damaged state, which is the point of pressing it.
    assert.ok(
      !panel.text().includes(DAMAGED_PATH),
      "the panel is still showing the damaged config after recovering from it",
    );
    // `assert.ok(!node)`, and never `assert.equal(node, null)`. A failing
    // assertion carries its `actual` to the reporter, and handing it a jsdom
    // element is the 772-second, 5,891 MB blow-up measured at the top of this
    // file — which neither the heap cap nor a parent-level `timeout` bounds.
    assert.ok(!button(panel.host, RECOVER), "the way out is still on screen");
    assert.match(panel.text(), /Nothing running here yet/, "the recovered panel is not usable");
  } finally {
    await panel.unmount();
  }
});

test("DOM: a refused write says so and keeps the way out on screen", async () => {
  const b = bridge({
    damaged: true,
    onSave: () => ({ ok: false, path: DAMAGED_PATH }),
  });
  const panel = await mount(b.api);
  try {
    await click(button(panel.host, RECOVER));
    await settle();

    assert.match(panel.text(), /That didn’t save/, "a refused write is not reported to the user");
    assert.ok(button(panel.host, RECOVER), "a refused recovery took the way out off screen");
  } finally {
    await panel.unmount();
  }
});

// ── the other affordance the damaged state changes ──────────────────────────

test("DOM: a damaged config takes the local Add button out of service", async () => {
  // Round 5's second finding, held until now ONLY by a grep for
  // `disabled={!!unreadable}` in mcp-panel-state.test.mjs — which is to say,
  // by reading source text. `saveMcpServers` refuses by default over a damaged
  // config, so a live button here opens a form that takes a name, a command
  // and a set of SECRETS and then has the write declined.
  const b = bridge({ damaged: true });
  const panel = await mount(b.api);
  try {
    const add = button(panel.host, "Add one on this computer");
    assert.ok(add, "the local Add button is not on screen");
    assert.equal(
      add.disabled,
      true,
      "the local Add button is live over a config that refuses every write",
    );
    assert.ok(
      (add.getAttribute("title") ?? "").length > 0,
      "the disabled Add button does not say why it is disabled",
    );

    // The remote half has nothing to do with this file, and disabling it too
    // would take away the one thing here that still works.
    const remote = button(panel.host, "Add by URL");
    assert.ok(remote, "the remote Add button is not on screen");
    assert.equal(remote.disabled, false, "a damaged LOCAL config disabled adding a REMOTE server");
  } finally {
    await panel.unmount();
  }
});

test("DOM: a readable config leaves the local Add button usable", async () => {
  // The other half of it: a `disabled` that is always true would satisfy the
  // test above and break the panel for everyone else.
  const b = bridge({ servers: [plaud] });
  const panel = await mount(b.api);
  try {
    const add = button(panel.host, "Add one on this computer");
    assert.ok(add, "the local Add button is not on screen");
    assert.equal(
      add.disabled,
      false,
      "adding a local server is disabled over a config that reads fine",
    );
  } finally {
    await panel.unmount();
  }
});

test("DOM: an Add form already open is closed when the config goes unreadable", async () => {
  // Round 5's second finding had a second half, and until now that half was
  // held only by a grep for `view.kind !== "unreadable"`. Deleting the
  // condition leaves a form on screen that goes on collecting a name, a
  // command and a set of SECRETS over a config where every write is refused.
  //
  // The config going bad under an open form is not hypothetical: the panel
  // re-reads whenever the agent changes, and the file can be replaced by
  // anything from a sync client to a half-finished hand edit.
  const b = bridge({ servers: [plaud] });
  const panel = await mount(b.api);
  try {
    await click(button(panel.host, "Add one on this computer"));
    await settle();
    assert.ok(
      panel.host.querySelector('input[placeholder="Plaud"]'),
      "the Add form did not open",
    );

    b.damage();
    await switchAgent("another-agent");

    assert.ok(
      !panel.host.querySelector('input[placeholder="Plaud"]'),
      "the Add form is still taking a name, a command and secrets over a config that refuses every write",
    );
    assert.ok(
      button(panel.host, RECOVER),
      "the user was left with neither a usable form nor the way out",
    );
  } finally {
    await panel.unmount();
  }
});

// ── the load actually happening ─────────────────────────────────────────────

test("DOM: with no bridge at all the panel says so rather than loading for ever", async () => {
  // ROUND 6'S SECOND CONDITION. `if (window.studio) await loadMcpPanel(...)`
  // is true in every other test in this file, which is why it needs its own:
  // with the preload script absent the guard skips the load, `servers` stays
  // null, and the permanent `Loading…` is back — while `NO_ANSWER_MESSAGE` and
  // the two unit tests that cover it go on describing a screen the shipped
  // component would never reach.
  const panel = await mount(undefined);
  try {
    assert.ok(
      !panel.text().includes("Loading…"),
      "no preload bridge leaves the panel loading for ever",
    );
    assert.ok(
      panel.text().includes(NO_ANSWER_MESSAGE),
      "the panel does not say why it has nothing to show",
    );
  } finally {
    await panel.unmount();
  }
});

test("DOM: a healthy config renders the servers it was given", async () => {
  const b = bridge({ servers: [plaud, arcana] });
  const panel = await mount(b.api);
  try {
    assert.equal(b.loads.length >= 1, true, "the mounted panel never asked for the servers");
    assert.match(panel.text(), /Plaud/, "a configured server is not on screen");
    assert.match(panel.text(), /Arcana/, "a configured server is not on screen");
    assert.ok(
      panel.text().includes("@plaud-ai/mcp@latest"),
      "the command a row describes is not rendered",
    );
    assert.ok(
      !button(panel.host, RECOVER),
      "a readable config is offering the damaged-config recovery",
    );
  } finally {
    await panel.unmount();
  }
});

// ── the search box ──────────────────────────────────────────────────────────

test("DOM: the search box filters the local list", async () => {
  // Round 6 found `const shownLocal = servers` green, which falsified the
  // claim in mcpPanel.ts that the only unpinned thing left was the kind-to-
  // markup mapping. Typing is the only way to see it: with no search term the
  // filtered list and the whole list are the same value.
  const b = bridge({ servers: [plaud, arcana] });
  const panel = await mount(b.api);
  try {
    const search = panel.host.querySelector('input[placeholder="Search plugins"]');
    assert.ok(search, "the search box is not on screen");

    await type(search, "plaud");
    await settle();

    assert.match(panel.text(), /Plaud/, "the server that matches the search is not shown");
    assert.ok(
      !panel.text().includes("Arcana"),
      "the search box does not filter the local list — every server is shown whatever is typed",
    );
  } finally {
    await panel.unmount();
  }
});

test("DOM: a search that matches nothing shows the empty state, not a list", async () => {
  const b = bridge({ servers: [plaud, arcana] });
  const panel = await mount(b.api);
  try {
    await type(panel.host.querySelector('input[placeholder="Search plugins"]'), "zzzz");
    await settle();

    assert.ok(!panel.text().includes("Plaud"), "a filtered-out server is still on screen");
    assert.match(panel.text(), /Nothing running here yet/, "the empty state is not rendered");
  } finally {
    await panel.unmount();
  }
});

// ── the second press, and the class the census generalises it to ────────────

test("DOM: a refused recovery can be pressed AGAIN, and the second press writes", async () => {
  // PAUL'S DOOR, round 7, first blocking finding. The refused-write test above
  // asserted only that the recovery button was still PRESENT, which is the
  // assertion this file's own round-7 door had already proved insufficient one
  // state earlier. `disabled={!!saveError}` on that button is green against
  // presence: a user with a damaged config whose quarantine is refused once
  // then sees "That didn't save", an escape hatch on screen, and a second press
  // that issues no write at all — the round 7 review measured `after press 2:
  // saves = 1` with the damaged path still on screen. MEASURED HERE, 25 Sep:
  // with that mutation applied this test fails on `recover.disabled`, and the
  // census row for the same state reports
  // `{ label: "Move it aside and start again", pressable: false }` where it
  // expects `true`.
  //
  // The INSTANCE is fixed here. The CLASS is fixed by the census below, which
  // asserts pressability for every button in every state rather than for this
  // one button in the two states a reviewer happened to name.
  let attempt = 0;
  const b = bridge({
    damaged: true,
    onSave: (next) => {
      attempt += 1;
      return attempt === 1 ? { ok: false, path: DAMAGED_PATH } : { ok: true, servers: next };
    },
  });
  const panel = await mount(b.api);
  try {
    await click(button(panel.host, RECOVER));
    await settle();
    assert.equal(b.saves.length, 1, "the first press issued no write");
    assert.match(panel.text(), /That didn’t save/, "a refused write is not reported to the user");

    const again = button(panel.host, RECOVER);
    assert.ok(again, "a refused recovery took the way out off screen");
    assert.equal(again.disabled, false, "the way out is unpressable after one refusal");

    await click(again);
    await settle();

    assert.equal(b.saves.length, 2, "the second press issued no write");
    assert.deepEqual(
      b.saves[1].options,
      { onUnreadableConfig: "quarantine" },
      "the second press stopped asking for the damaged file to be moved aside",
    );
    assert.ok(
      !panel.text().includes(DAMAGED_PATH),
      "the panel is still showing the damaged config after a recovery that worked",
    );
    assert.ok(!panel.text().includes("That didn’t save"), "a write that worked still says it did not");
    assert.ok(!button(panel.host, RECOVER), "the way out is still on screen after recovering");
  } finally {
    await panel.unmount();
  }
});

// ── THE AFFORDANCE CENSUS ───────────────────────────────────────────────────
//
// Every button the panel body renders in every state THIS LIST NAMES, with
// whether it can actually be PRESSED — asserted by EXACT equality against a
// stated list, not by looking up the one button a test cares about.
//
// Two limits, both found by round 8 and both stated rather than fixed. The
// census is bounded by its fixtures: a label only some `enabled` value produces
// is unreachable unless a fixture produces it. And it measures `disabled` and
// nothing else — it never presses. See KYB-597.
//
// Why exact equality rather than a lookup. Four rounds on this PR each pinned
// the instance they were handed: round 5 pinned that the local Add button is
// dead over a damaged config, round 6 pinned that the recovery button exists,
// round 7 pinned that it is pressable in the FRESH damaged state — and each
// time the next mutation moved one state along and was green. A lookup can only
// fail for a button someone thought to look up. An exact census fails for any
// button that appears, disappears or changes its `disabled` anywhere in the
// panel, including ones nobody has written a test for yet.
//
// `pressable` is deliberately BOTH checks. `disabled` the property and
// `disabled` the attribute can disagree, and React writes the attribute.
//
// The records are PLAIN DATA. That is not a readability preference: it is the
// trap at the top of this file. `assert.deepEqual` on a mismatch hands `actual`
// to the reporter, and a census of jsdom nodes would be the 772-second,
// 5,891 MB failure rather than a one-line diff.

/** A stable name for a button, including the icon-only ones that have no text. */
function affordance(element) {
  const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
  if (text) return text;
  const title = element.getAttribute("title");
  if (title) return `[${title}]`;
  return `[${element.className || "unlabelled"}]`;
}

/**
 * Every button in the panel BODY, in DOM order, as `{ label, pressable }`.
 *
 * Scoped to `.modal__body`, which is the tab content. The modal's own chrome —
 * the close button and the four tab buttons — belongs to the dialog rather than
 * to this panel, and is driven by `mount()` instead.
 */
function censusOf(host) {
  const body = host.querySelector(".modal__body");
  assert.ok(body, "the modal body is not on screen");
  return [...body.querySelectorAll("button")].map((element) => ({
    label: affordance(element),
    pressable: element.disabled === false && !element.hasAttribute("disabled"),
  }));
}

const ADD_REMOTE = { label: "Add by URL", pressable: true };
const addLocal = (pressable) => ({ label: "Add one on this computer", pressable });
const ROW = [
  { label: "Connect", pressable: true },
  { label: "[More]", pressable: true },
];

/**
 * Every state the panel body can be in that this harness can reach, with the
 * exact set of affordances it offers there.
 *
 * `view` names the `McpPanelView` kind the state is in. A test below reads the
 * union out of `mcpPanel.ts` and fails if a kind has no row here, which is what
 * makes an N+1th STATE hard to add without a test.
 */
const STATES = [
  {
    name: "the first answer has not arrived",
    view: "loading",
    // A bridge that never answers is how this state is held still. It
    // is also the state the last four rounds of this PR kept producing by
    // accident, which is why it is worth a row: the panel offers NOTHING here,
    // so anything that strands a user in it strands them with no way out.
    reach: () => mount(bridge({ pending: ["mcpServers"] }).api),
    expect: [],
    // The only row whose expectation is empty, so the only one that would pass
    // against a screen with no buttons for the WRONG reason — a tab click that
    // silently landed somewhere else, say. `censusOf` asserts `.modal__body`
    // exists, but that element is on the Apps tab too. Pair it with something
    // positive so this row fails for the right reason.
    alsoShows: /Loading…/,
  },
  {
    name: "a damaged config, freshly read",
    view: "unreadable",
    reach: () => mount(bridge({ damaged: true }).api),
    expect: [{ label: RECOVER, pressable: true }, ADD_REMOTE, addLocal(false)],
  },
  {
    name: "a damaged config whose quarantine was refused",
    view: "unreadable",
    // THE ROUND 7 DOOR. `disabled={!!saveError}` on the recovery button is
    // green everywhere except this row.
    reach: async () => {
      const b = bridge({ damaged: true, onSave: () => ({ ok: false, path: DAMAGED_PATH }) });
      const panel = await mount(b.api);
      await click(button(panel.host, RECOVER));
      await settle();
      return panel;
    },
    expect: [{ label: RECOVER, pressable: true }, ADD_REMOTE, addLocal(false)],
  },
  {
    name: "a damaged config whose next read then threw",
    view: "unreadable",
    // Two failures stacked: `unreadable` survives a later load failure, so the
    // way out has to survive it too. A third unreadable sub-state, and the
    // reason the census is a table rather than two assertions.
    reach: async () => {
      const b = bridge({ damaged: true });
      const panel = await mount(b.api);
      b.api.mcpServers = async () => {
        throw new Error("disk");
      };
      await switchAgent("another-agent");
      return panel;
    },
    expect: [{ label: RECOVER, pressable: true }, ADD_REMOTE, addLocal(false)],
  },
  {
    name: "a readable config with servers",
    view: "list",
    reach: () => mount(bridge({ servers: [plaud, arcana] }).api),
    expect: [...ROW, ...ROW, ADD_REMOTE, addLocal(true)],
  },
  {
    name: "a readable config with a row menu open",
    view: "list",
    // The per-row menu was on this file's NOT-COVERED list until round 7. Two
    // of the three buttons in it call `save()`, which is the same write path
    // the damaged-config work is about.
    reach: async () => {
      const panel = await mount(bridge({ servers: [plaud, arcana] }).api);
      await click(button(panel.host, "More") ?? panel.host.querySelector('button[title="More"]'));
      await settle();
      return panel;
    },
    expect: [
      ...ROW,
      { label: "Check again", pressable: true },
      { label: "Turn off", pressable: true },
      { label: "Remove", pressable: true },
      ...ROW,
      ADD_REMOTE,
      addLocal(true),
    ],
  },
  {
    // The same menu over a server that is TURNED OFF. Not a duplicate of the row
    // above: the menu's middle entry is `{s.enabled ? "Turn off" : "Turn on"}`,
    // so the two fixtures reach two different labels, and anything conditioned
    // on `enabled` is invisible from the row above alone.
    name: "a row menu open on a server that is turned off",
    view: "list",
    reach: async () => {
      const panel = await mount(bridge({ servers: [dormant] }).api);
      await click(button(panel.host, "More") ?? panel.host.querySelector('button[title="More"]'));
      await settle();
      return panel;
    },
    expect: [
      ...ROW,
      { label: "Check again", pressable: true },
      { label: "Turn on", pressable: true },
      { label: "Remove", pressable: true },
      ADD_REMOTE,
      addLocal(true),
    ],
  },
  {
    name: "a readable config with no servers",
    view: "empty",
    reach: () => mount(bridge({ servers: [] }).api),
    expect: [ADD_REMOTE, addLocal(true)],
  },
  {
    name: "a search that matches nothing",
    view: "empty",
    reach: async () => {
      const panel = await mount(bridge({ servers: [plaud, arcana] }).api);
      await type(panel.host.querySelector('input[placeholder="Search plugins"]'), "zzzz");
      await settle();
      return panel;
    },
    expect: [ADD_REMOTE, addLocal(true)],
  },
  {
    name: "no preload bridge at all",
    view: "empty",
    reach: () => mount(undefined),
    expect: [ADD_REMOTE, addLocal(true)],
  },
  {
    name: "a read that threw",
    view: "empty",
    // `loadError` is a banner and not a state of its own, so the affordances
    // are the empty ones. Pinned because a read failure that ALSO took the Add
    // buttons away would leave a user with a working app and nothing to press.
    reach: () => mount(bridge({ rejects: ["mcpServers"] }).api),
    expect: [ADD_REMOTE, addLocal(true)],
  },
  {
    name: "the local Add form open",
    view: "list",
    reach: async () => {
      const panel = await mount(bridge({ servers: [plaud] }).api);
      await click(button(panel.host, "Add one on this computer"));
      await settle();
      return panel;
    },
    expect: [...ROW, { label: "Add", pressable: true }, { label: "Cancel", pressable: true }],
  },
  {
    name: "the remote Add form open",
    view: "list",
    // `AddRemoteServer` was on the NOT-COVERED list too. It is rendered here
    // and nothing is submitted: the census says what it offers, not what its
    // buttons do.
    reach: async () => {
      const panel = await mount(bridge({ servers: [plaud] }).api);
      await click(button(panel.host, "Add by URL"));
      await settle();
      return panel;
    },
    expect: [...ROW, { label: "Add", pressable: true }, { label: "Cancel", pressable: true }],
  },
];

for (const state of STATES) {
  test(`DOM: affordance census — ${state.name}`, async () => {
    const panel = await state.reach();
    try {
      assert.deepEqual(censusOf(panel.host), state.expect);
      // A row whose whole expectation is "no buttons" would pass against the
      // wrong screen. `alsoShows` is how such a row states what it IS.
      if (state.alsoShows) assert.match(panel.text(), state.alsoShows);
      else assert.ok(state.expect.length > 0, "a row with no buttons must set alsoShows");
    } finally {
      await panel.unmount();
      takeEscaped();
    }
  });
}

test("DOM: every view kind the panel can be in has a census row", async () => {
  // A COVERAGE assertion, and deliberately the only source-reading one in this
  // file. It does not claim anything about behaviour — the census rows do that
  // — it claims that the census has a row for each `kind` the panel can render.
  // Adding a fifth kind to `McpPanelView` fails here until someone writes down
  // what the panel offers in it.
  //
  // NOT covered by this: a new state that is not a new KIND, such as a fourth
  // value of `mode`. The exactness of each census row is what catches those,
  // and only once someone reaches the state.
  const source = readFileSync(new URL("../src/renderer/src/lib/mcpPanel.ts", import.meta.url), "utf8");
  const start = source.indexOf("export type McpPanelView");
  assert.notEqual(start, -1, "McpPanelView is no longer declared where this test looks for it");
  // To the blank line, not to the first `;`: the members themselves contain
  // semicolons — `{ kind: "unreadable"; path: string }` — and slicing to the
  // first one found two kinds and silently under-checked. That is why the
  // length assertion below exists rather than trusting the parse.
  const union = source.slice(start, source.indexOf("\n\n", start));
  const kinds = [...new Set([...union.matchAll(/kind:\s*"([a-z]+)"/g)].map((m) => m[1]))].sort();
  assert.ok(kinds.length >= 4, `only found ${kinds.length} kinds — the union is not being parsed`);
  assert.deepEqual(
    [...new Set(STATES.map((s) => s.view))].sort(),
    kinds,
    "a view kind has no row in the affordance census, or a census row names a kind that no longer exists",
  );
});

// ── THE BRIDGE FAILING, on every method it exposes ──────────────────────────
//
// Round 7's second blocking finding was not that `connectors()` can reject. It
// was that NOTHING in this file could fail at anything, so a whole category of
// mutation was invisible. The fix is the category: every method the bridge
// exposes can reject, and every one of them has a stated expected behaviour
// here. The table is guarded against a method being added without one.

const WHEN_IT_FAILS = {
  connectors:
    "the REMOTE call. The local half must be completely unaffected: the damaged " +
    "screen, its path, and a way out that is pressable AND still writes. Driven " +
    "as a call that never answers rather than one that rejects — see the test, " +
    "which says why a rejecting one cannot be observed from a mounted panel.",
  mcpServers:
    "the LOCAL read. Never a permanent `Loading…`: an empty list, the reason on " +
    "screen, and the Add buttons still usable. The remote half is still asked for.",
  saveMcpServers:
    "the LOCAL write. The refusal is reported, and the way out stays on screen and " +
    "stays pressable so the user can try again.",
};

test("DOM: every bridge method has a stated behaviour for when it fails", () => {
  assert.deepEqual(Object.keys(WHEN_IT_FAILS).sort(), [...BRIDGE_METHODS].sort());
});

test("DOM: a connectors() that never answers leaves the whole local half working", async () => {
  // PAUL'S DOOR, round 7, second blocking finding. Swapping the two awaits in
  // `refresh()` — `connectors()` first, `loadMcpPanel` second — typechecks and
  // leaves the suite green without this test: the remote call is awaited before
  // the local half is ever loaded, `servers` stays null, and the panel sits on
  // `Loading…` with no error and no recovery button.
  //
  // WHY A HANG AND NOT A REJECTION, since a rejection is what the review asked
  // for. MEASURED 25 Sep: `rejects: ["connectors"]` here does close the same
  // door, but the rejection then FAILS THIS TEST whatever it asserts. The
  // component's `useEffect(() => { void refresh(); }, [agent])` discards it, so
  // it arrives as a process-level unhandled rejection, and the node:test runner
  // attributes one to whichever test is running — a `process.on(
  // "unhandledRejection")` listener does not take that away, and the escape can
  // land after the test that caused it, failing the NEXT one instead.
  //
  // That is not a gap in this harness. It IS the pre-existing defect the review
  // named: a rejecting `connectors()` is a silent failure at head too, dropped
  // on the floor with nothing on screen saying why. Fixing it is outside
  // KYB-590 and is being filed separately. Until it is fixed, a remote call
  // that never answers is the strongest form of this door a mounted-panel test
  // can hold — and it is the same shape of failure, an await that does not
  // return, which is what the mutation exploits.
  const b = bridge({ damaged: true, pending: ["connectors"] });
  const panel = await mount(b.api);
  try {
    assert.ok(
      !panel.text().includes("Loading…"),
      "a REMOTE call that never answers left the whole panel loading for ever",
    );
    assert.ok(b.calls.includes("mcpServers"), "the local half was never asked for at all");
    assert.match(panel.text(), /damaged and can’t be read/, "the damaged state is not shown");
    assert.ok(panel.text().includes(DAMAGED_PATH), "the path to repair by hand is not shown");

    const recover = button(panel.host, RECOVER);
    assert.ok(recover, "a stuck remote call took the way out off screen");
    assert.equal(recover.disabled, false, "a stuck remote call left the way out unpressable");

    // And it still WORKS, not merely renders.
    await click(recover);
    await settle();
    assert.equal(b.saves.length, 1, "the way out issued no write while the remote call was stuck");
    assert.ok(
      !panel.text().includes(DAMAGED_PATH),
      "recovering did not clear the damaged screen while the remote call was stuck",
    );
  } finally {
    await panel.unmount();
  }
});

test("DOM: a rejecting mcpServers() states the reason and leaves the panel usable", async () => {
  const b = bridge({ rejects: ["mcpServers"] });
  const panel = await mount(b.api);
  try {
    assert.ok(!panel.text().includes("Loading…"), "a failing local read leaves the panel loading");
    assert.match(panel.text(), /Couldn’t read your servers/, "a failing read says nothing at all");
    assert.ok(
      panel.text().includes(BRIDGE_FAILURE),
      "the panel says a read failed without saying what the failure was",
    );
    // The mirror of the `connectors` case: a failing LOCAL read must not take
    // the REMOTE half down either.
    assert.ok(b.calls.includes("connectors"), "a failing local read stopped the remote half loading");
    assert.deepEqual(takeEscaped(), [], "a failing read escaped the component instead of being folded");
  } finally {
    await panel.unmount();
    takeEscaped();
  }
});

test("DOM: a rejecting saveMcpServers() reports it and keeps the way out pressable", async () => {
  const b = bridge({ damaged: true, rejects: ["saveMcpServers"] });
  const panel = await mount(b.api);
  try {
    await click(button(panel.host, RECOVER));
    await settle();

    assert.ok(b.calls.includes("saveMcpServers"), "the recovery never reached the bridge");
    assert.match(panel.text(), /That didn’t save/, "a write that threw is not reported to the user");
    assert.ok(
      panel.text().includes(BRIDGE_FAILURE),
      "the panel says a write failed without saying what the failure was",
    );

    const recover = button(panel.host, RECOVER);
    assert.ok(recover, "a write that threw took the way out off screen");
    assert.equal(recover.disabled, false, "a write that threw left the way out unpressable");
    assert.deepEqual(takeEscaped(), [], "a failing write escaped the component instead of being folded");
  } finally {
    await panel.unmount();
    takeEscaped();
  }
});

test("DOM: nothing else in this file left a rejection unhandled", async () => {
  // The price of the `unhandledRejection` listener above is that it silences
  // the default abort for the WHOLE file. This is the receipt: anything that
  // escaped and was not drained by the test that expected it fails here.
  await settle();
  assert.deepEqual(takeEscaped(), []);
});
