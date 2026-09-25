import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  SAVE_REFUSED_MESSAGE,
  initialMcpPanelState,
  panelAfterLoad,
  panelAfterLoadFailure,
  panelAfterSave,
  panelAfterSaveFailure,
} from "../src/renderer/src/lib/mcpPanel.ts";

/**
 * The state the MCP panel lands in after an answer.
 *
 * WHAT THIS FILE PROVES, and what it does not — stated plainly, because review
 * round 4 rejected an earlier claim here as unsupported and was right to.
 *
 * It proves the panel's state DECISION: given an answer from the main process,
 * what does the panel hold. Every assertion below calls a real function and
 * checks a real returned value, so deleting the handling of an unreadable
 * config from either answer path fails an assertion about behaviour.
 *
 * It does NOT prove what a person sees. Nothing under `test/` can render a
 * `.tsx` — there is no DOM harness and no React test renderer in this repo, and
 * adding one is not this change. The bridge from this state to the screen is
 * still read by eye, and the last test in this file is a SOURCE-LEVEL check of
 * that wiring, labelled as such and deliberately kept out of the load-bearing
 * assertions.
 *
 * WHY THE SHAPE CHANGED IN ROUND 5. The earlier version of this file tested a
 * single `applyMcpServersResult(result)` while `Plugins.tsx` held three pieces
 * of state and set them one at a time. A reviewer deleted `setUnreadable(...)`
 * at `Plugins.tsx:349` and again at `:424`, separately, and got 273/273 both
 * times: the assertions here could not see it, and the source-level guard
 * counted `applyMcpServersResult(` occurrences, which neither mutation
 * changed. The component now holds ONE object and applies it whole, so there
 * is no half left to delete — the `unreadable` decision is inside the
 * functions this file calls.
 */

const server = { id: "s1", name: "db", command: "npx", args: [], enabled: true };
const DAMAGED = {
  ok: false,
  code: "MCP_CONFIG_UNREADABLE",
  path: "/home/someone/.config/Studio/local-mcp.json",
};

/** The state a panel is in once it has successfully shown a list. */
const settled = panelAfterLoad(initialMcpPanelState, { ok: true, servers: [server] });

test("nothing has been asked yet, so the panel is loading", () => {
  // `initialMcpPanelState` is what `Plugins.tsx` passes to `useState`, so this
  // is the state a real panel starts in — round 4 noted that while it was
  // unused this test asserted a constant against itself and could not fail. It
  // is still a weak test on its own, which is why the assertions that matter
  // are below: `Loading…` is rendered on `servers === null`, and no function in
  // this module may return that state after an answer, successful or not.
  assert.equal(initialMcpPanelState.servers, null);
  assert.equal(initialMcpPanelState.unreadable, null);
  assert.equal(initialMcpPanelState.saveError, null);
  assert.equal(initialMcpPanelState.loadError, null);
});

// ── the load path (Plugins.tsx `refresh`) ───────────────────────────────────

test("a healthy answer clears any error and shows the servers", () => {
  const state = panelAfterLoad(initialMcpPanelState, { ok: true, servers: [server] });

  assert.deepEqual(state.servers, [server]);
  assert.equal(state.unreadable, null);
});

test("LOAD: an unreadable config is an EMPTY list AND a stated error, never a bare empty", () => {
  // M13. Two defects in one assertion, and it needs both halves:
  //
  //   `servers: null` is the permanent-`Loading…` bug — the panel renders
  //   `Loading…` on null and never leaves it, with the recovery button three
  //   lines away and unreachable.
  //
  //   `unreadable: null` alongside `servers: []` is the DISHONEST EMPTY. The
  //   panel then renders "Nothing running here yet — a server on this machine
  //   is reachable by your agents…", which is a false statement about a config
  //   the app cannot read, and the recovery button is not rendered at all. It
  //   is the same thing `localMcp.ts` refuses to do one layer down: "the honest
  //   answer to 'I cannot tell' is not 'there are none'".
  //
  // Mutation: delete the `ok: false` branch of `panelAfterLoad`, or drop
  // `unreadable` from it, and this goes red.
  const state = panelAfterLoad(initialMcpPanelState, DAMAGED);

  assert.notEqual(state.servers, null, "the panel would render Loading… for ever");
  assert.deepEqual(state.servers, []);
  assert.deepEqual(
    state.unreadable,
    { path: DAMAGED.path },
    "an empty list with no error renders as “you have none” over a config we cannot read",
  );
});

test("LOAD: recovering clears the error state, so the panel goes back to normal", () => {
  // The user presses the recovery button, the damaged file is moved aside and
  // an empty config written. If the error state survived that answer the panel
  // would keep offering a way out of a problem that no longer exists.
  const after = panelAfterLoad(panelAfterLoad(initialMcpPanelState, DAMAGED), {
    ok: true,
    servers: [],
  });

  assert.deepEqual(after.servers, []);
  assert.equal(after.unreadable, null);
});

test("LOAD: a successful read does not pretend a refused write happened", () => {
  // `refresh()` runs on its own schedule — a poll, a window focus, an agent
  // switch. If it cleared `saveError` then a Remove that was refused would stop
  // saying so a few seconds later, which is the silent failure again with a
  // delay on it.
  const refused = panelAfterSave(settled, DAMAGED);
  const after = panelAfterLoad(refused, { ok: true, servers: [server] });

  assert.equal(after.saveError, SAVE_REFUSED_MESSAGE, "the refused write stopped being reported");
});

test("LOAD: a rejected read still leaves a list, never null", () => {
  // `mcpServers()` answers a damaged config with a VALUE, so a rejection here
  // is something else: a disk fault, a permission error, a bug in main. It is
  // called as `void refresh()`, which discards the rejection entirely — so
  // without this the panel sat on `Loading…` for ever, which is exactly the
  // defect round 3 blocked on, reached through a different door.
  const state = panelAfterLoadFailure(initialMcpPanelState, new Error("EACCES: permission denied"));

  assert.notEqual(state.servers, null, "a failed read renders Loading… for ever");
  assert.deepEqual(state.servers, []);
  assert.match(state.loadError ?? "", /EACCES/);
});

test("LOAD: a rejected read does not throw away the list already on screen", () => {
  const state = panelAfterLoadFailure(settled, new Error("the main process went away"));

  assert.deepEqual(state.servers, [server], "a failed refresh emptied a list that was fine");
  assert.match(state.loadError ?? "", /main process/);
});

// ── the save path (Plugins.tsx `save`) ──────────────────────────────────────

test("SAVE: a refused write says so, and does not empty the panel in silence", () => {
  // Round 3's finding, reinstated as an assertion. The user presses Remove over
  // a damaged config. `saveMcpServers` refuses by default — nothing is written
  // — and answers `{ ok: false }`. The failure mode this pins down: `servers:
  // []` with `unreadable: null` and `saveError: null`, which is a list that
  // empties itself while nothing says no.
  //
  // Mutation: delete the `ok: false` branch of `panelAfterSave`, or set
  // `saveError: null` in it, and this goes red.
  const state = panelAfterSave(settled, DAMAGED);

  assert.deepEqual(state.unreadable, { path: DAMAGED.path }, "the refusal was not shown at all");
  assert.notEqual(state.saveError, null, "the write was refused and the panel said nothing");
  assert.equal(state.saveError, SAVE_REFUSED_MESSAGE);
  assert.deepEqual(state.servers, []);
});

test("SAVE: a refused write does not clear a failure already on screen", () => {
  const already = panelAfterSaveFailure(settled, new Error("ENOSPC: no space left on device"));
  const state = panelAfterSave(already, DAMAGED);

  assert.notEqual(state.saveError, null, "a second refusal wiped the first one off the screen");
});

test("SAVE: a write that went through clears both error states", () => {
  const state = panelAfterSave(panelAfterSave(settled, DAMAGED), { ok: true, servers: [server] });

  assert.deepEqual(state.servers, [server]);
  assert.equal(state.unreadable, null, "the way out is still offered after the way out worked");
  assert.equal(state.saveError, null);
});

test("SAVE: a rejected write is reported rather than discarded", () => {
  // Every write in the panel is `void save(...)`, which discards a rejection
  // entirely: the row simply does not change and nothing says why.
  const state = panelAfterSaveFailure(settled, new Error("EROFS: read-only file system"));

  assert.match(state.saveError ?? "", /EROFS/);
  assert.deepEqual(state.servers, [server], "a failed write emptied the list");
});

test("SAVE: a non-Error rejection is still reported", () => {
  assert.equal(panelAfterSaveFailure(settled, "something odd").saveError, "something odd");
});

// ── the wiring, source-level and labelled as such ───────────────────────────

test("SOURCE ONLY: the component holds one state object and applies it whole", () => {
  // This test reads text. It proves the component is wired to the functions
  // above; it proves NOTHING about what is rendered, and it is not counted as
  // killing either mutation named in the comments above — those are killed by
  // the behavioural assertions in this file, which is the point of the reducer
  // shape.
  //
  // It earns its place for one reason: every assertion above describes a
  // function, and describes nothing at all if `Plugins.tsx` has gone back to
  // setting three pieces of state by hand. That regression is what round 4
  // found, and it is the only thing checked here.
  const source = readFileSync("src/renderer/src/components/Plugins.tsx", "utf8");

  for (const gone of ["setLocal(", "setUnreadable(", "setSaveError(", "applyMcpServersResult("]) {
    assert.ok(
      !source.includes(gone),
      `${gone} is back: the split state is what made deleting the unreadable half free`,
    );
  }

  // Both answer sites, and both rejection sites, each folded through a function
  // this file tests.
  for (const fold of [
    "panelAfterLoad(",
    "panelAfterLoadFailure(",
    "panelAfterSave(",
    "panelAfterSaveFailure(",
  ]) {
    assert.ok(source.includes(fold), `Plugins.tsx no longer folds an answer through ${fold}`);
  }

  // Every `setPanel` applies exactly what a fold returned, and nothing else.
  // This is the one structural invariant that a behavioural test cannot reach:
  // the fold can be correct and the component can still override half of its
  // answer on the way into state — `setPanel((prev) => ({ ...panelAfterSave(
  // prev, answer), unreadable: null }))` typechecks, and no test in this repo
  // can render the result. An ADDITION rather than a deletion, and this is the
  // only thing standing in front of it. Said as a limit, not as a claim.
  const applications = source.match(/setPanel\(/g) ?? [];
  const clean = source.match(/setPanel\(\(prev\) => panelAfter\w+\(prev, \w+\)\)/g) ?? [];
  assert.equal(
    clean.length,
    applications.length,
    "a setPanel call does something other than apply a fold's answer unchanged",
  );
  assert.equal(applications.length, 4, "the panel has more or fewer than its four answer sites");

  assert.ok(
    source.includes('if (!local) return <div className="empty">Loading…</div>;'),
    "the Loading… guard this file reasons about has moved or changed",
  );
  assert.ok(
    source.includes('onUnreadableConfig: "quarantine"'),
    "no recovery affordance passes the quarantine option",
  );
  assert.match(source, /\{saveError \?/, "the caught write failure is never rendered");
  assert.match(source, /\{loadError \?/, "the caught read failure is never rendered");
  assert.match(
    source,
    /disabled=\{!!unreadable\}/,
    "the local Add button is live over a config that refuses every write",
  );
});
