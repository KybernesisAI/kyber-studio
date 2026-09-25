import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { applyMcpServersResult, initialMcpPanelState } from "../src/renderer/src/lib/mcpPanel.ts";

/**
 * The state the MCP panel lands in after an answer.
 *
 * Nothing here renders React: there is no DOM harness in this repo and adding
 * one is not this change. What it tests instead is the decision the component
 * makes, moved out of the `.tsx` so a test can reach it at all — see the
 * remarks on `mcpPanel.ts` for why that move is the point rather than a dodge.
 *
 * The bridge from this state to what a person sees is one line in
 * `Plugins.tsx`: `if (!local) return <div className="empty">Loading…</div>;`.
 * So `servers === null` after an answer IS the permanent-`Loading…` bug. The
 * last test in this file asserts that line and the call that feeds it are both
 * still there, because otherwise these assertions describe a function the
 * component has stopped using.
 */

const server = { id: "s1", name: "db", command: "npx", args: [], enabled: true };

test("nothing has been asked yet, so the panel is loading", () => {
  assert.equal(initialMcpPanelState.servers, null);
  assert.equal(initialMcpPanelState.unreadable, null);
});

test("a healthy answer clears any error and shows the servers", () => {
  const state = applyMcpServersResult({ ok: true, servers: [server] });

  assert.deepEqual(state.servers, [server]);
  assert.equal(state.unreadable, null);
});

test("an unreadable config leaves an EMPTY list, never null", () => {
  // M13. `servers: null` here is the whole defect: the panel renders
  // `Loading…` on null and never leaves it, so the user sees a spinner for
  // ever with the recovery button three lines away and unreachable. Deleting
  // the `ok: false` branch from `applyMcpServersResult` turns this red.
  const state = applyMcpServersResult({
    ok: false,
    code: "MCP_CONFIG_UNREADABLE",
    path: "/home/someone/.config/Studio/local-mcp.json",
  });

  assert.notEqual(state.servers, null, "the panel would render Loading… for ever");
  assert.deepEqual(state.servers, []);
  assert.deepEqual(state.unreadable, {
    path: "/home/someone/.config/Studio/local-mcp.json",
  });
});

test("recovering clears the error state, so the panel goes back to normal", () => {
  // The user presses the recovery button, the damaged file is moved aside and
  // an empty config written. If the error state survived that answer the panel
  // would keep offering a way out of a problem that no longer exists.
  const after = applyMcpServersResult({ ok: true, servers: [] });

  assert.deepEqual(after.servers, []);
  assert.equal(after.unreadable, null);
});

test("the component still routes its answers through this function", () => {
  // Source-level, and deliberately so: these assertions are worth nothing if
  // `Plugins.tsx` has gone back to setting state straight from the result. It
  // proves the wiring is present, not that it renders — a claim this file has
  // no way to make and does not make.
  const source = readFileSync("src/renderer/src/components/Plugins.tsx", "utf8");

  // At least twice, because there are two answer sites — the initial
  // `mcpServers()` and every `saveMcpServers()` — and folding only one of them
  // leaves the other able to strand the panel. A single `includes` was
  // satisfied by a mutant that reverted `refresh` and left `save` alone.
  // The import does not count — it survives a revert that stops using the
  // function, and `strict` does not flag an unused one.
  const folds = source
    .split("\n")
    .filter((l) => l.includes("applyMcpServersResult(")).length;
  assert.ok(
    folds >= 2,
    `Plugins.tsx folds only ${folds} of its two answer sites through applyMcpServersResult`,
  );
  assert.ok(
    source.includes('if (!local) return <div className="empty">Loading…</div>;'),
    "the Loading… guard this file reasons about has moved or changed",
  );
  assert.ok(
    source.includes('onUnreadableConfig: "quarantine"'),
    "no recovery affordance passes the quarantine option",
  );

  // Every write in this panel is called as `void save(...)`, which discards a
  // rejection entirely: the row simply does not change and nothing says why.
  // So `save` has to catch, and the caught thing has to be rendered.
  assert.match(
    source,
    /} catch \(error\) \{[\s\S]{0,400}?setSaveError\(/,
    "save() no longer catches, so a failed write is discarded silently again",
  );
  assert.match(source, /\{saveError \?/, "the caught failure is never rendered");
});
