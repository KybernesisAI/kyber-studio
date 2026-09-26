import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  NO_ANSWER_MESSAGE,
  SAVE_REFUSED_MESSAGE,
  initialMcpPanelState,
  loadMcpPanel,
  panelAfterLoad,
  panelAfterLoadFailure,
  panelAfterSave,
  panelAfterSaveFailure,
  panelView,
  saveMcpPanel,
} from "../src/renderer/src/lib/mcpPanel.ts";

/**
 * The MCP panel: what state an answer lands it in, how the answer gets there,
 * and what the panel then shows.
 *
 * WHAT THIS FILE PROVES, and what it does not — stated plainly, because review
 * round 4 rejected an earlier claim here as unsupported and was right to.
 *
 * It proves three decisions, each by calling a real function and checking a
 * real returned value:
 *
 *   1. THE FOLD. Given an answer from the main process, what does the panel
 *      hold. `panelAfterLoad` and friends.
 *   2. THE WAY IN. Given a bridge that answers, refuses, is absent, or throws,
 *      what reaches state. `loadMcpPanel` and `saveMcpPanel`.
 *   3. THE RENDER DECISION. Given a state, which of the four things does the
 *      panel show. `panelView`.
 *
 * It does NOT prove what a person sees. That is `test/mcp-panel-dom.test.mjs`,
 * added in round 7, which mounts `Plugins` under jsdom and drives it through
 * `act()`: this file holds the decisions, that one holds the screen.
 *
 * The last test here is a SOURCE-LEVEL check of the wiring between the two,
 * labelled as such and kept out of the load-bearing assertions. Round 6 and
 * round 7 each found a mutation it could not see, both times because the text
 * it greps for was still there and only the code around it had changed.
 *
 * WHY THE SHAPE CHANGED IN ROUND 5. The earlier version of this file tested a
 * single `applyMcpServersResult(result)` while `Plugins.tsx` held three pieces
 * of state and set them one at a time. A reviewer deleted `setUnreadable(...)`
 * at `Plugins.tsx:349` and again at `:424`, separately, and got 273/273 both
 * times: the assertions here could not see it, and the source-level guard
 * counted `applyMcpServersResult(` occurrences, which neither mutation changed.
 * The component then held ONE object and applied it whole, so there was no half
 * left to delete.
 *
 * WHY IT CHANGED AGAIN IN ROUND 6, which is the important part. Pinning the
 * fold left the CALL unpinned, and the reviewer walked straight through it:
 *
 *     -  if (answer) setPanel((prev) => panelAfterLoad(prev, answer));
 *     +  if (answer?.ok) setPanel((prev) => panelAfterLoad(prev, answer));
 *
 * Both typechecks passed, the build passed, and the suite stayed at 285/285.
 * The damaged-config answer was dropped on the floor, `servers` stayed `null`,
 * and the permanent `Loading…` was back — the defect this whole change exists
 * to remove, reinstated for free. The source guard could not see it because it
 * matched the SHAPE of each `setPanel` call and that shape had not changed;
 * what changed was whether the call ran.
 *
 * So the condition is gone rather than guarded. Every fold now accepts the
 * absent answer and states an error for it, and the awaiting, the application
 * and the catch moved into `loadMcpPanel`/`saveMcpPanel`, which this file calls
 * directly with a fake bridge. `Plugins.tsx` no longer invokes the setter at
 * all, so the reviewer's edit cannot be written there; written here instead, it
 * fails the assertions under "the way in" below. Both doors, and the mutation
 * log in the PR records each one red.
 */

const server = { id: "s1", name: "db", command: "npx", args: [], enabled: true };
const DAMAGED = {
  ok: false,
  code: "MCP_CONFIG_UNREADABLE",
  path: "/home/someone/.config/Studio/local-mcp.json",
};

/** The state a panel is in once it has successfully shown a list. */
const settled = panelAfterLoad(initialMcpPanelState, { ok: true, servers: [server] });

/**
 * A stand-in for `setPanel`, which is what `Plugins.tsx` hands over.
 *
 * It keeps the last state AND counts applications, because "applied twice" and
 * "not applied at all" are both failure modes worth telling apart from
 * "applied once with the wrong value".
 */
function panelUnderTest(from = initialMcpPanelState) {
  const box = {
    state: from,
    applications: 0,
    apply(fold) {
      box.state = fold(box.state);
      box.applications += 1;
    },
  };
  return box;
}

test("nothing has been asked yet, so the panel is loading", () => {
  // `initialMcpPanelState` is what `Plugins.tsx` passes to `useState`, so this
  // is the state a real panel starts in — round 4 noted that while it was
  // unused this test asserted a constant against itself and could not fail. It
  // is still a weak test on its own, which is why the assertions that matter
  // are below: `Loading…` is rendered on the `loading` kind, `panelView`
  // returns that kind exactly on `servers === null`, and no function in this
  // module may return that state after an answer, successful or not.
  assert.equal(initialMcpPanelState.servers, null);
  assert.equal(initialMcpPanelState.unreadable, null);
  assert.equal(initialMcpPanelState.saveError, null);
  assert.equal(initialMcpPanelState.loadError, null);
  assert.equal(panelView(initialMcpPanelState, []).kind, "loading");
});

// ── the load fold (mcpPanel `panelAfterLoad`) ───────────────────────────────

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

test("LOAD: NO answer at all is a stated error, not a silent no-op", () => {
  // The case the old `if (answer)` swallowed. `window.studio` is injected by
  // the preload script, so `window.studio?.mcpServers()` is `undefined`
  // whenever that script did not run. The fold takes it rather than the caller
  // guarding against it, which is the whole point: there is no condition left
  // in `Plugins.tsx` to narrow.
  //
  // Mutation: return `previous` unchanged from the `!result` branch, and this
  // goes red on `servers` still being null.
  const state = panelAfterLoad(initialMcpPanelState, undefined);

  assert.notEqual(state.servers, null, "an absent answer renders Loading… for ever");
  assert.deepEqual(state.servers, []);
  assert.equal(state.loadError, NO_ANSWER_MESSAGE, "nothing said why the panel is empty");
});

test("LOAD: an absent answer does not throw away the list already on screen", () => {
  const state = panelAfterLoad(settled, undefined);

  assert.deepEqual(state.servers, [server], "a missing answer emptied a list that was fine");
  assert.equal(state.loadError, NO_ANSWER_MESSAGE);
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

// ── the save fold (mcpPanel `panelAfterSave`) ───────────────────────────────

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

test("SAVE: NO answer at all is a stated error, and changes nothing else", () => {
  // Same absent bridge as the load path, and the opposite obligation about the
  // list: nothing was written and nothing was read, so the panel has learnt
  // nothing about what is on disk. Emptying the list would be as much a lie as
  // reporting success.
  const state = panelAfterSave(settled, undefined);

  assert.equal(state.saveError, NO_ANSWER_MESSAGE, "a write that never happened said nothing");
  assert.deepEqual(state.servers, [server], "an absent answer emptied the list");
  assert.equal(state.unreadable, null, "an absent answer invented a damaged config");
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

test("SAVE: a write that went through also clears a stale READ error", () => {
  // Round 5's first non-blocking finding. `save()` does not re-`refresh()`, so
  // if `loadError` were carried through the ok branch then "Couldn't read your
  // servers: EIO" would sit above a list that a later write has just proved
  // accurate, with nothing to clear it until the next refresh happened to run.
  //
  // Mutation: drop `loadError: null` from the `ok: true` branch, and this goes
  // red.
  const stale = panelAfterLoadFailure(settled, new Error("EIO: i/o error"));
  const state = panelAfterSave(stale, { ok: true, servers: [server] });

  assert.equal(state.loadError, null, "a read error outlived the write that disproved it");
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

// ── the way in (mcpPanel `loadMcpPanel` / `saveMcpPanel`) ───────────────────
//
// THE SECTION ROUND 5 DID NOT HAVE. Every assertion above describes a fold, and
// a correct fold that never runs is exactly the bug the reviewer reinstated
// with `if (answer?.ok)`. These call the functions that do the awaiting, so a
// condition in front of an application is a failure here rather than a green
// suite.

test("IN: a damaged config reaches state — the caller gets no say in it", () => {
  // THE ROUND 5 MUTATION, killed. Writing `if (answer?.ok) apply(...)` inside
  // `loadMcpPanel` drops this answer, leaves `servers` null, and fails on the
  // first assertion. Writing `if (answer) apply(...)` passes this one and fails
  // the absent-bridge test below.
  //
  // WITHDRAWN 25 Sep: this note used to add that there was "no third place to
  // put the condition". There is, and round 6 used it — a condition in front of
  // the CALL to `loadMcpPanel`, in `Plugins.tsx`. The source check at the
  // bottom of this file cannot see that, because the call is still written
  // there and still matches. What sees it is `test/mcp-panel-dom.test.mjs`,
  // which mounts the component with no bridge and fails on `Loading…`.
  const panel = panelUnderTest();

  return loadMcpPanel({ mcpServers: async () => DAMAGED }, panel.apply).then(() => {
    assert.equal(panel.applications, 1, "the answer was applied the wrong number of times");
    assert.notEqual(panel.state.servers, null, "the answer was dropped: Loading… for ever");
    assert.deepEqual(panel.state.unreadable, { path: DAMAGED.path }, "the way out is not offered");
  });
});

test("IN: a healthy answer reaches state", async () => {
  const panel = panelUnderTest();

  await loadMcpPanel({ mcpServers: async () => ({ ok: true, servers: [server] }) }, panel.apply);

  assert.deepEqual(panel.state.servers, [server]);
  assert.equal(panel.state.loadError, null);
  assert.equal(panel.applications, 1);
});

test("IN: no bridge at all is a stated error, not a silent no-op", async () => {
  // `window.studio` is `undefined`, so `window.studio?.mcpServers()` is too.
  // The old `if (answer)` made this case do nothing whatsoever and the panel
  // loaded for ever with no explanation.
  const panel = panelUnderTest();

  await loadMcpPanel(undefined, panel.apply);

  assert.equal(panel.applications, 1, "an absent bridge was skipped entirely");
  assert.deepEqual(panel.state.servers, [], "the panel is still loading with nothing coming");
  assert.equal(panel.state.loadError, NO_ANSWER_MESSAGE);
});

test("IN: a rejected read is caught and stated, never left to `void refresh()`", async () => {
  const panel = panelUnderTest();

  await loadMcpPanel(
    {
      mcpServers: async () => {
        throw new Error("EACCES: permission denied");
      },
    },
    panel.apply,
  );

  assert.deepEqual(panel.state.servers, []);
  assert.match(panel.state.loadError ?? "", /EACCES/);
});

test("IN: a refused write reaches state WHOLE — the refusal cannot be trimmed on the way", async () => {
  // M-P5, killed. The other shape the reviewer named: not dropping the
  // application but overriding part of what the fold returned on its way into
  // state — `apply((prev) => ({ ...panelAfterSave(prev, answer), unreadable:
  // null }))`. That is an ADDITION rather than a deletion, and round 5 could
  // only stand a regex in front of it. Here it is a value: trimming
  // `unreadable` or `saveError` off this answer fails an assertion.
  const panel = panelUnderTest(settled);

  await saveMcpPanel({ saveMcpServers: async () => DAMAGED }, panel.apply, []);

  assert.deepEqual(panel.state.unreadable, { path: DAMAGED.path }, "the refusal was trimmed off");
  assert.equal(panel.state.saveError, SAVE_REFUSED_MESSAGE, "Remove looked as though it worked");
  assert.equal(panel.applications, 1);
});

test("IN: no bridge for a write is a stated error", async () => {
  const panel = panelUnderTest(settled);

  await saveMcpPanel(undefined, panel.apply, []);

  assert.equal(panel.state.saveError, NO_ANSWER_MESSAGE);
  assert.deepEqual(panel.state.servers, [server], "a write that never happened emptied the list");
});

test("IN: a rejected write is caught and stated", async () => {
  const panel = panelUnderTest(settled);

  await saveMcpPanel(
    {
      saveMcpServers: async () => {
        throw new Error("EROFS: read-only file system");
      },
    },
    panel.apply,
    [],
  );

  assert.match(panel.state.saveError ?? "", /EROFS/);
});

test("IN: the servers and the quarantine option both reach the bridge", async () => {
  // The escape hatch is `save([], { onUnreadableConfig: "quarantine" })`, and
  // `saveMcpServers` refuses by default — so a `saveMcpPanel` that forgot to
  // forward `options` would leave the recovery button pressing itself against a
  // refusal for ever, with the panel unchanged and no test saying why. Round 3
  // called the unreachable escape hatch the defect; this is the argument that
  // keeps it reachable.
  const seen = [];
  const panel = panelUnderTest(settled);

  await saveMcpPanel(
    {
      saveMcpServers: async (servers, options) => {
        seen.push({ servers, options });
        return { ok: true, servers };
      },
    },
    panel.apply,
    [],
    { onUnreadableConfig: "quarantine" },
  );

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].servers, []);
  assert.deepEqual(seen[0].options, { onUnreadableConfig: "quarantine" });
  assert.equal(panel.state.unreadable, null, "the panel is still stuck after recovering");
});

// ── the render decision (mcpPanel `panelView`) ──────────────────────────────
//
// The other half of round 5's finding. This decision used to be a chain of
// ternaries in the JSX, which nothing reached until `test/mcp-panel-dom.test.mjs`.

test("VIEW: nothing has arrived yet, so the panel is loading — and only then", () => {
  assert.equal(panelView(initialMcpPanelState, []).kind, "loading");
  assert.equal(panelView({ ...initialMcpPanelState, servers: [] }, []).kind, "empty");
});

test("VIEW: a damaged config shows the way out, not a list and not an empty", () => {
  // Deleting the `unreadable` arm was free while it lived in JSX: the panel
  // fell through to "Nothing running here yet — a server on this machine is
  // reachable by your agents", which is false about a config we cannot read,
  // and the recovery button vanished with the arm.
  const state = panelAfterLoad(initialMcpPanelState, DAMAGED);
  const view = panelView(state, []);

  assert.equal(view.kind, "unreadable");
  assert.equal(view.path, DAMAGED.path, "the panel cannot say which file to look at");
});

test("VIEW: unreadable beats a list that is somehow still on screen", () => {
  // Defence in depth, and not hypothetical: `panelAfterSave`'s refusal sets
  // `unreadable` while a previous successful read is what put rows there. The
  // list must not win — showing servers we cannot verify, over a file we cannot
  // read, with no way out, is the round 3 screen again.
  const view = panelView({ ...settled, unreadable: { path: DAMAGED.path } }, [server]);

  assert.equal(view.kind, "unreadable");
});

test("VIEW: a list is shown when there is something to show", () => {
  const view = panelView(settled, [server]);

  assert.equal(view.kind, "list");
  assert.deepEqual(view.servers, [server]);
});

test("VIEW: the list shown is the FILTERED one, not everything configured", () => {
  // `visible` is the list after the panel's search box. Ignoring it and
  // rendering `state.servers` would make the search box do nothing.
  const two = { ...settled, servers: [server, { ...server, id: "s2", name: "redis" }] };
  const view = panelView(two, [server]);

  assert.equal(view.kind, "list");
  assert.deepEqual(view.servers, [server], "the search box was ignored");
});

test("VIEW: no rows to show is empty, which is an honest thing to say here", () => {
  assert.equal(panelView(settled, []).kind, "empty");
});

test("VIEW: an error that is not `unreadable` does not hide the list", () => {
  // `loadError` and `saveError` render as a line above the list, not instead of
  // it: a failed refresh does not make the servers already on screen untrue.
  const state = panelAfterLoadFailure(settled, new Error("EIO: i/o error"));

  assert.equal(panelView(state, [server]).kind, "list");
});

// ── the wiring, source-level and labelled as such ───────────────────────────

test("SOURCE ONLY: the component decides nothing — it hands over the setter and switches on a view", () => {
  // This test reads text. It proves the component is wired to the functions
  // above; it proves NOTHING about what is rendered, and it is not counted as
  // killing any mutation named in the comments above — those are killed by the
  // behavioural assertions in this file, which is the point of moving the
  // decisions out of the `.tsx`.
  //
  // It earns its place for one reason: every assertion above describes a
  // function, and describes nothing at all if `Plugins.tsx` has gone back to
  // deciding for itself. Round 4 found that regression as split state; round 5
  // found it as a condition in front of a correct fold. Both are checked here,
  // and both are also checked behaviourally above — which is the difference
  // from round 5, where this file was the only thing standing in front of them.
  const source = readFileSync("src/renderer/src/components/Plugins.tsx", "utf8");

  for (const gone of ["setLocal(", "setUnreadable(", "setSaveError(", "applyMcpServersResult("]) {
    assert.ok(
      !source.includes(gone),
      `${gone} is back: the split state is what made deleting the unreadable half free`,
    );
  }

  // The component does not invoke the state setter, so a condition in front of
  // an APPLICATION — or an override trimming an answer on its way past — has to
  // be written inside `mcpPanel.ts`, where the section above drives it.
  //
  // WITHDRAWN 25 Sep: this was headed "THE ROUND 6 INVARIANT" and read as
  // though it closed the class. It does not. Round 6 conditioned the two CALLS
  // instead, and round 7 disabled the button one of them sits behind; all three
  // edits leave every string this test greps for matching.
  // `test/mcp-panel-dom.test.mjs` is what holds them.
  assert.ok(
    !source.includes("setPanel("),
    "Plugins.tsx applies state itself again: that is where `if (answer?.ok)` came in",
  );
  // ...and the folds are not reachable from here either, so there is nothing to
  // call conditionally even if a call site came back.
  assert.ok(
    !source.includes("panelAfter"),
    "a fold is applied in the component again rather than by the tested way in",
  );

  // Both answer paths go through the functions this file drives, and the setter
  // is handed to each of them exactly once.
  assert.equal(
    (source.match(/loadMcpPanel\(window\.studio, setPanel\)/g) ?? []).length,
    1,
    "the load path no longer goes through the tested way in",
  );
  assert.equal(
    (source.match(/saveMcpPanel\(window\.studio, setPanel, next, options\)/g) ?? []).length,
    1,
    "the save path no longer goes through the tested way in, or drops its options",
  );

  // The render decision is taken by `panelView` and only switched on here. A
  // fourth kind added to the union with no arm here is the thing this cannot
  // see; it is a limit, and it is stated rather than papered over.
  assert.match(
    source,
    /const view = panelView\(panel, shownLocal\)/,
    "the render decision has moved back into the component",
  );
  assert.ok(
    source.includes('if (view.kind === "loading") return <div className="empty">Loading…</div>;'),
    "the Loading… guard this file reasons about has moved or changed",
  );
  assert.match(source, /view\.kind === "unreadable" \?/, "the damaged-config screen is not rendered");
  assert.match(source, /view\.kind === "list" \?/, "the list is no longer rendered from the view");
  assert.ok(
    source.includes('onUnreadableConfig: "quarantine"'),
    "no recovery affordance passes the quarantine option",
  );
  assert.match(source, /\{saveError \?/, "the caught write failure is never rendered");
  assert.match(source, /\{loadError \?/, "the caught read failure is never rendered");

  // Round 5's second non-blocking finding. `disabled` stops the form being
  // OPENED; the second condition closes one already open when the config goes
  // unreadable, which otherwise takes a name, a command and a set of secrets
  // and then has the write refused.
  assert.match(
    source,
    /disabled=\{!!unreadable\}/,
    "the local Add button is live over a config that refuses every write",
  );
  assert.match(
    source,
    /mode === "local" && view\.kind !== "unreadable" \?/,
    "an Add form already open keeps taking secrets after the config goes unreadable",
  );
});
