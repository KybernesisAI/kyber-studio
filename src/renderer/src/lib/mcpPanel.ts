import type { LocalMcpServer, McpServersResult } from "../../../shared/ipc";

/**
 * What the MCP panel holds after an answer from the main process.
 *
 * @remarks
 * This is a module and not a handful of `useState` calls inside `Plugins.tsx`
 * for one reason: nothing under `test/` can render a `.tsx`, so a decision left
 * in the component is a decision no test can reach — and the decision here is
 * the one review keeps finding unmade. `listServers` began refusing to answer a
 * damaged config, `Plugins.tsx` never handled the refusal, and the panel sat on
 * `Loading…` for ever with the escape hatch three lines away and unreachable.
 *
 * **Why ONE object and one setter, rather than four pieces of state.** Round 4
 * found that the earlier shape left a free mutation: the component held
 * `local`, `unreadable` and `saveError` separately, so each answer needed
 * several independent `setX(...)` calls and DELETING ONE OF THEM changed
 * behaviour while the whole suite stayed green. Dropping `setUnreadable(...)`
 * from the load path produced `servers: []` with no error, which renders
 * "Nothing running here yet" over a config the app cannot read — the same
 * dishonest empty `localMcp.ts` refuses to invent one layer down. Dropping it
 * from the save path was worse: a REFUSED write emptied the list and cleared
 * the error, so Remove looked as though it had worked.
 *
 * The state is therefore a single value, produced whole by the functions below
 * and applied by a single `setPanel(...)` per answer. There is no longer a
 * "half" to delete: the `unreadable` decision lives in a pure function that
 * `test/mcp-panel-state.test.mjs` calls directly, so removing it fails an
 * assertion about a returned value rather than a grep over source text.
 *
 * The invariant, stated so a test can hold it: `servers` is `null` ONLY while
 * the first answer is outstanding. `Plugins.tsx` renders `Loading…` exactly
 * when it is `null`, so any state that leaves it `null` after an answer has
 * arrived — or after a FAILED one — IS the permanent-loading bug, whatever the
 * answer said.
 */
export interface McpPanelState {
  /** `null` only before the first answer. Never `null` after one. */
  servers: LocalMcpServer[] | null;
  /**
   * Set when the config on disk cannot be read. The panel shows a distinct
   * error state and a way out; the path is what tells the user which file to
   * look at if they would rather repair it by hand.
   */
  unreadable: { path: string } | null;
  /**
   * The last write that did not go through. Every write in the panel is called
   * as `void save(...)`, which discards a rejection entirely, so without this
   * the row simply does not change and nothing says why.
   */
  saveError: string | null;
  /**
   * The last READ that did not go through. Distinct from `saveError` because
   * the user's response is distinct — nothing of theirs was lost, the panel
   * just cannot show what is there — and distinct from `unreadable`, which is
   * the one read failure that arrives as a value and carries a remedy.
   */
  loadError: string | null;
}

export const initialMcpPanelState: McpPanelState = {
  servers: null,
  unreadable: null,
  saveError: null,
  loadError: null,
};

/**
 * What the panel says when a write was refused because the config is damaged.
 *
 * Exported so a test asserts the value the component renders rather than a
 * string of its own. The write did NOT happen, and saying so is the whole
 * point: the alternative — the list quietly emptying — is what round 3 called
 * "Remove silently failed".
 */
export const SAVE_REFUSED_MESSAGE =
  "your list of servers on this computer can’t be read, so nothing was written";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fold an answer from `mcpServers()` into the panel state.
 *
 * An unreadable config yields an EMPTY list rather than `null`: we genuinely do
 * not know what servers the user has, `[]` is the only list we can show, and —
 * unlike the `[]` that `listServers` used to invent — it is never written back,
 * because every write goes through `saveMcpServers`, which refuses by default.
 * `unreadable` is what stops that `[]` being read as "you have none".
 *
 * `saveError` is carried through untouched. A read says nothing about whether
 * the last write landed, and a successful read after a refused write does not
 * make that write have happened.
 */
export function panelAfterLoad(previous: McpPanelState, result: McpServersResult): McpPanelState {
  if (result.ok) {
    return { ...previous, servers: result.servers, unreadable: null, loadError: null };
  }
  return { ...previous, servers: [], unreadable: { path: result.path }, loadError: null };
}

/**
 * Fold a REJECTED `mcpServers()` into the panel state.
 *
 * `mcpServers()` answers a damaged config with a value, so a rejection here is
 * something else — a disk fault, a permission error, a bug in the main process.
 * It still must not leave `servers` null: `void refresh()` discards the
 * rejection, and a null list renders `Loading…` for ever, which is the defect
 * this whole change exists to remove. An empty list with a stated error is the
 * honest floor.
 */
export function panelAfterLoadFailure(previous: McpPanelState, error: unknown): McpPanelState {
  return { ...previous, servers: previous.servers ?? [], loadError: message(error) };
}

/**
 * Fold an answer from `saveMcpServers()` into the panel state.
 *
 * The `ok: false` branch is the one round 4 blocked on. A refused write leaves
 * the config exactly as it was, so the panel must say two things at once: the
 * config cannot be read (with the way out), and THIS WRITE DID NOT HAPPEN. It
 * must not clear `saveError`, because clearing it is precisely how a refused
 * Remove came to look like a successful one.
 */
export function panelAfterSave(previous: McpPanelState, result: McpServersResult): McpPanelState {
  if (result.ok) {
    return { ...previous, servers: result.servers, unreadable: null, saveError: null };
  }
  return {
    ...previous,
    servers: [],
    unreadable: { path: result.path },
    saveError: SAVE_REFUSED_MESSAGE,
  };
}

/** Fold a REJECTED `saveMcpServers()` — a disk fault, a permission error. */
export function panelAfterSaveFailure(previous: McpPanelState, error: unknown): McpPanelState {
  return { ...previous, saveError: message(error) };
}
