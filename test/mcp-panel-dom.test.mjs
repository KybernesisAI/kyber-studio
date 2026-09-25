import { after, test } from "node:test";
import assert from "node:assert/strict";
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
 * WHAT IT DOES NOT PIN, and this list is the honest part. The Apps, Marketplace
 * and Yours tabs are never opened; `AppsTab` mounts only because the panel opens
 * on it. `AddRemoteServer` is never rendered. Nothing here submits the local Add
 * form, opens the per-row menu, or drives Remove, Turn off, Connect or Check —
 * on either half. The remote server list is always empty. Styling, layout and
 * the modal's own open/close are not looked at. A regression in any of those is
 * NOT covered here.
 *
 * ONE TRAP, MEASURED WHILE BUILDING THIS. Never let a jsdom node be the `actual`
 * of an assertion — `assert.equal(node, null)` rather than `assert.ok(!node)`.
 * On failure the runner serialises `actual` for the report, and serialising an
 * element took 134 seconds and then reported the FILE as failed instead of the
 * test. It reads exactly like the hang a mutant produces.
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

// ── driving it ──────────────────────────────────────────────────────────────

// ── runaway guard ───────────────────────────────────────────────────────────
//
// An effect that sets state on an unstable dependency renders for ever. The
// runner's --test-timeout CANNOT interrupt that: the loop is synchronous
// allocation, so the process reaches OOM long before any timer is allowed to
// fire. Measured on this box: 6.0GB in 103 seconds, which takes the whole VM
// down rather than failing a test.
//
// Counting commits is the only hook inside the loop. The soft limit is asserted
// between interactions, where a throw is a clean failure; the hard ceiling
// throws inside the commit itself, because by then nothing else will stop it.
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

function click(element) {
  return act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/**
 * Type into a CONTROLLED input. Setting `.value` alone is invisible to React —
 * it tracks the previous value on the node and suppresses the change — so the
 * native setter goes through the prototype descriptor.
 */
function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    "value",
  ).set;
  setter.call(input, value);
  return act(async () => {
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
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

/**
 * A bridge that records what the panel asked it to do.
 *
 * `damage()` flips it AFTER mounting, which is how the config-goes-bad-while-
 * you-are-typing case below is reached: the panel re-reads on a change of
 * agent, and that is a thing a user does.
 */
function bridge({ servers = [], damaged = false, onSave } = {}) {
  const saves = [];
  const loads = [];
  let bad = damaged;
  return {
    saves,
    loads,
    damage: () => {
      bad = true;
    },
    api: {
      connectors: async () => ({ configured: true, connectors: [] }),
      mcpServers: async () => {
        loads.push(Date.now());
        return bad ? { ok: false, path: DAMAGED_PATH } : { ok: true, servers };
      },
      saveMcpServers: async (next, options) => {
        saves.push({ servers: next, options });
        return onSave ? onSave(next, options) : { ok: true, servers: next };
      },
    },
  };
}

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
    // `assert.ok(!node)` and never `assert.equal(node, undefined)`: a failing
    // assertion carries its `actual` to the reporter, and asking it to
    // serialise a jsdom element takes the runner over two minutes and then
    // reports the FILE rather than this test. Measured while building this.
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
