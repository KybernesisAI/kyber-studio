import type { LocalMcpServer, McpServersResult } from "../../../shared/ipc";

/**
 * What the MCP panel holds after an answer from the main process.
 *
 * @remarks
 * This is a function and not four lines inside `Plugins.tsx` for one reason:
 * nothing under `test/` can render a `.tsx`, so a decision left in the
 * component is a decision no test can reach — and the decision here is the one
 * a review found unmade. `listServers` began refusing to answer a damaged
 * config, `Plugins.tsx` never handled the refusal, and the panel sat on
 * `Loading…` for ever with the escape hatch three lines away and unreachable.
 *
 * The invariant, stated so a test can hold it: `servers` is `null` ONLY while
 * the first answer is outstanding. `Plugins.tsx` renders `Loading…` exactly
 * when it is `null`, so any state that leaves it `null` after an answer has
 * arrived IS the permanent-loading bug, whatever the answer said.
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
}

export const initialMcpPanelState: McpPanelState = { servers: null, unreadable: null };

/**
 * Fold an answer from `mcpServers` or `saveMcpServers` into the panel state.
 *
 * An unreadable config yields an EMPTY list rather than `null`: we genuinely do
 * not know what servers the user has, `[]` is the only list we can show, and —
 * unlike the `[]` that `listServers` used to invent — it is never written back,
 * because every write goes through `saveMcpServers`, which refuses by default.
 */
export function applyMcpServersResult(result: McpServersResult): McpPanelState {
  if (result.ok) return { servers: result.servers, unreadable: null };
  return { servers: [], unreadable: { path: result.path } };
}
