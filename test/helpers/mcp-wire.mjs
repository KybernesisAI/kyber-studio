import { replyFromWire, serversToWire } from "../../src/shared/envPairs.ts";

/**
 * A main-process `invoke` that calls the two MCP-config handlers the way the
 * renderer does since KYB-700: each server's `env` sent as pairs, and the reply
 * decoded back to maps with the panel's own codec. Every other channel is
 * passed through untouched.
 *
 * For the tests written against the handlers before the bridge carried pairs,
 * which assert what the main process does with an env, not how it crosses.
 * What crosses, and what the context bridge does to it, is
 * `test/mcp-env-pairs-*.test.mjs`'s.
 */
export function asRenderer(invoke) {
  const decoded = (reply) =>
    reply && typeof reply.then === "function" ? reply.then(replyFromWire) : replyFromWire(reply);
  return (channel, ...args) => {
    if (channel === "studio:saveMcpServers") {
      const [servers, ...rest] = args;
      return decoded(invoke(channel, serversToWire(servers), ...rest));
    }
    if (channel === "studio:mcpServers") return decoded(invoke(channel, ...args));
    return invoke(channel, ...args);
  };
}

/** Every malformed `env` the save handler must refuse, by what is wrong with it. */
export const MALFORMED_ENVS = {
  "an object (the old shape)": { KYB_A: "SECRET-VALUE" },
  "a string": "KYB_A=SECRET-VALUE",
  "a number": 42,
  null: null,
  "a boolean": true,
  "a list holding a string, not a pair": ["KYB_A=SECRET-VALUE"],
  "a list holding a pair of length 1": [["KYB_A"]],
  "a list holding a pair of length 3": [["KYB_A", "SECRET-VALUE", "more"]],
  "a list holding a pair whose value is not a string": [["KYB_A", 1]],
  "a list holding a pair whose key is not a string": [[1, "SECRET-VALUE"]],
  "a list holding null": [null],
  "a list with the same key twice": [["KYB_A", "SECRET-VALUE"], ["KYB_A", "OTHER-VALUE"]],
};
