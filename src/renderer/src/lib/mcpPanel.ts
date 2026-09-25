import type { LocalMcpServer, McpServersResult, SaveMcpServersOptions } from "../../../shared/ipc";

/**
 * What the MCP panel holds after an answer from the main process, how it gets
 * there, and what it shows.
 *
 * @remarks
 * This is a module and not a handful of `useState` calls inside `Plugins.tsx`
 * for one reason: nothing under `test/` can render a `.tsx`, so a decision left
 * in the component is a decision no test can reach — and the decision here is
 * the one review keeps finding unmade. `listServers` began refusing to answer a
 * damaged config, `Plugins.tsx` never handled the refusal, and the panel sat on
 * `Loading…` for ever with the escape hatch three lines away and unreachable.
 *
 * **Why ONE object and one application, rather than four pieces of state.**
 * Round 4 found that the earlier shape left a free mutation: the component held
 * `local`, `unreadable` and `saveError` separately, so each answer needed
 * several independent `setX(...)` calls and DELETING ONE OF THEM changed
 * behaviour while the whole suite stayed green. Dropping `setUnreadable(...)`
 * from the load path produced `servers: []` with no error, which renders
 * "Nothing running here yet" over a config the app cannot read — the same
 * dishonest empty `localMcp.ts` refuses to invent one layer down. Dropping it
 * from the save path was worse: a REFUSED write emptied the list and cleared
 * the error, so Remove looked as though it had worked.
 *
 * **Why the CALL as well as the fold, in round 6.** Round 5 pinned the fold and
 * left the way in unpinned. The component still read
 *
 * ```ts
 * const answer = await window.studio?.mcpServers();
 * if (answer) setPanel((prev) => panelAfterLoad(prev, answer));
 * ```
 *
 * and narrowing that condition to `if (answer?.ok)` typechecked under both
 * tsconfigs, built, and left the suite at 285/285 — measured, not argued. The
 * `{ ok: false }` answer was dropped on the floor, `servers` stayed `null`, and
 * the permanent `Loading…` came back. The fold was right and unreachable.
 * Guarding the SHAPE of the `setPanel` call could not see it, because nothing
 * about that call had changed; what changed was whether it ran.
 *
 * So the condition is gone rather than guarded, in both directions:
 *
 * - **The folds take the absent answer.** `panelAfterLoad` and `panelAfterSave`
 *   accept `McpServersResult | undefined`, and `undefined` produces a STATED
 *   error, never a silent no-op. There is nothing left for an `if` to protect.
 * - **The asking moved here too.** `loadMcpPanel` and `saveMcpPanel` own the
 *   await, the branch-free application and the catch, so `Plugins.tsx` contains
 *   no `setPanel(` call at all — it hands the setter over and has no site to
 *   put a condition in front of. Re-introducing the condition means writing it
 *   in THIS file, where `test/mcp-panel-state.test.mjs` calls both functions
 *   with a fake bridge and asserts the state that came out. That is an
 *   assertion about a returned value, not a grep over source text.
 *
 * `panelView` is the same move applied to the render decision, which was the
 * other half still living in JSX no test can reach.
 *
 * The invariant, stated so a test can hold it: `servers` is `null` ONLY while
 * the first answer is outstanding. `panelView` returns `"loading"` exactly when
 * it is `null` and `Plugins.tsx` renders `Loading…` exactly on `"loading"`, so
 * any state that leaves it `null` after an answer has arrived — or after a
 * FAILED or ABSENT one — IS the permanent-loading bug, whatever the answer
 * said.
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

/**
 * What the panel says when the bridge to the main process answered with nothing
 * at all.
 *
 * `window.studio` is injected by the preload script, so `window.studio?.x()`
 * yields `undefined` whenever that script did not run — a preload that threw, a
 * window opened without it, a renderer reloaded against a torn-down main
 * process. Rare, and NOT a reason to say nothing: the old code dropped that
 * case with `if (answer)` and the panel sat on `Loading…` for ever, which is
 * the same defect as a dropped `{ ok: false }` reached through a quieter door.
 * An empty list with a stated error is the honest floor.
 */
export const NO_ANSWER_MESSAGE =
  "the app didn’t answer — try closing this window and opening it again";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fold an answer from `mcpServers()` into the panel state.
 *
 * Takes `undefined` deliberately: see `NO_ANSWER_MESSAGE`. Every case ends with
 * `servers` non-null, so no answer of any kind can leave the panel loading.
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
export function panelAfterLoad(
  previous: McpPanelState,
  result: McpServersResult | undefined,
): McpPanelState {
  if (!result) {
    return { ...previous, servers: previous.servers ?? [], loadError: NO_ANSWER_MESSAGE };
  }
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
 *
 * `undefined` — no bridge — is a stated `saveError` and NOT a change to
 * `servers`: nothing was written, and we have learnt nothing about what is on
 * disk, so both emptying the list and inventing one would be lies.
 *
 * The `ok: true` branch clears `loadError` too, which round 5 flagged as a
 * loose end. A successful write answers with the list it wrote, so the panel is
 * now holding an accurate one; leaving "Couldn't read your servers" above it
 * would describe a read that a later write has already superseded. Clearing it
 * here is why `save()` does not need to re-`refresh()` afterwards.
 */
export function panelAfterSave(
  previous: McpPanelState,
  result: McpServersResult | undefined,
): McpPanelState {
  if (!result) {
    return { ...previous, saveError: NO_ANSWER_MESSAGE };
  }
  if (result.ok) {
    return {
      ...previous,
      servers: result.servers,
      unreadable: null,
      saveError: null,
      loadError: null,
    };
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

/**
 * The part of the preload bridge this panel uses.
 *
 * Structural and narrow, so a test supplies a two-method object rather than a
 * whole `Studio`, and so this module never reaches for `window` — the component
 * passes `window.studio` in, `undefined` and all.
 */
export interface McpPanelApi {
  mcpServers(): Promise<McpServersResult>;
  saveMcpServers(
    servers: LocalMcpServer[],
    options?: SaveMcpServersOptions,
  ): Promise<McpServersResult>;
}

/** How a fold reaches state. React's `setPanel` satisfies this as it stands. */
export type ApplyMcpPanel = (fold: (previous: McpPanelState) => McpPanelState) => void;

/**
 * Ask for the servers and fold whatever comes back — value, absence or throw.
 *
 * Unconditional by construction, and that is the whole reason this function
 * exists rather than sitting inline in the component: exactly one `apply` per
 * outcome, no `if` in front of any of them, and the outcomes are lines a test
 * can drive. Adding a condition here — `if (answer?.ok)`, `if (answer)` —
 * fails `test/mcp-panel-state.test.mjs` on a returned value, which is what
 * round 5 asked for and what a source-level guard could not give.
 */
export async function loadMcpPanel(
  api: McpPanelApi | undefined,
  apply: ApplyMcpPanel,
): Promise<void> {
  try {
    const answer = await api?.mcpServers();
    apply((previous) => panelAfterLoad(previous, answer));
  } catch (error) {
    apply((previous) => panelAfterLoadFailure(previous, error));
  }
}

/**
 * Write the servers and fold whatever comes back.
 *
 * `options` is forwarded rather than dropped: `onUnreadableConfig:
 * "quarantine"` is the ONLY way out of a damaged config the user has, and a
 * version of this that forgot to pass it would leave the recovery button
 * pressing itself against a refusal for ever. A test drives that argument.
 */
export async function saveMcpPanel(
  api: McpPanelApi | undefined,
  apply: ApplyMcpPanel,
  servers: LocalMcpServer[],
  options?: SaveMcpServersOptions,
): Promise<void> {
  try {
    const answer = await api?.saveMcpServers(servers, options);
    apply((previous) => panelAfterSave(previous, answer));
  } catch (error) {
    // Every caller in the panel is `void save(...)`, so without this a rejected
    // write vanished into an unhandled promise and the row simply did not
    // change — the user pressed Remove and nothing said no.
    apply((previous) => panelAfterSaveFailure(previous, error));
  }
}

/**
 * Which of the four things the local half of the panel shows.
 *
 * `visible` is the server list AFTER the panel's search box has filtered it,
 * because "is there anything to show" is a question about what the user would
 * actually see, not about what is configured.
 */
export type McpPanelView =
  | { kind: "loading" }
  | { kind: "unreadable"; path: string }
  | { kind: "list"; servers: LocalMcpServer[] }
  | { kind: "empty" };

/**
 * Decide what the panel shows, as a value rather than as a chain of ternaries
 * inside JSX.
 *
 * Round 5's second half. The state decision was pinned and the RENDER decision
 * was not: `unreadable ? … : shownLocal.length ? … : …` sat in the component,
 * where no test in this repo can reach it, so deleting the `unreadable` arm put
 * "Nothing running here yet — a server on this machine is reachable by your
 * agents" over a config the app cannot read, with the recovery button gone, and
 * the suite stayed green. Moving the decision here makes that deletion an
 * assertion about a returned `kind`.
 *
 * The precedence, in order and each for a reason:
 *
 * 1. `loading` — `servers === null`, and ONLY then. Every fold above ends with
 *    a non-null list, so this state cannot survive an answer.
 * 2. `unreadable` — beats both list states. We cannot tell what is configured,
 *    so neither a list nor "you have none" is a true thing to say, and the way
 *    out is the only thing this panel can honestly offer.
 * 3. `list` — there is something for the user to look at.
 * 4. `empty` — there genuinely is not.
 *
 * What this does NOT prove: that `Plugins.tsx` renders each `kind` the way the
 * names suggest. There is no DOM harness in this repo, so the mapping from
 * `kind` to markup is still read by eye and pinned only by a source-level
 * check, which is labelled as such in the test file.
 */
export function panelView(state: McpPanelState, visible: LocalMcpServer[]): McpPanelView {
  if (state.servers === null) return { kind: "loading" };
  if (state.unreadable) return { kind: "unreadable", path: state.unreadable.path };
  if (visible.length) return { kind: "list", servers: visible };
  return { kind: "empty" };
}
