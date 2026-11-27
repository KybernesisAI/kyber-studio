import type {
  EnvPairs,
  HeldKeyPairs,
  LocalMcpServer,
  LocalMcpServerOnWire,
  McpServersReply,
  McpServersResult,
} from "./ipc";

/**
 * The codec for the two maps that cross the context bridge keyed by strings a
 * person chose: each server's `env`, and `heldKeys` (KYB-700).
 *
 * @remarks
 * The copy `contextBridge.exposeInMainWorld` makes omits an own key named
 * `__proto__` from every object it copies, whatever its value, and gives every
 * object it copies `Object.prototype` (measured on Electron 34.5.8, in both
 * directions). So a map with a `__proto__` key lost it on the way to the main
 * process and on the way back, without a word. As `[key, value]` pairs no key
 * is ever an object key while it crosses, and pairs were measured to arrive
 * intact.
 *
 * Both sides use this one module. The renderer encodes in `mcpPanel.ts` before
 * `saveMcpServers` and decodes both replies there; the main process decodes in
 * the `studio:saveMcpServers` handler before anything else runs, and encodes
 * what both handlers return. Nothing outside those two places sees pairs.
 *
 * Decoding builds into `Object.create(null)`, so no key reaches a setter and a
 * repeated key is visible, then returns an ordinary copy, as `sealEnv` does.
 * The copy keeps `__proto__` as an own data property and has
 * `Object.prototype`, which is the shape every caller received before this
 * codec existed, so nothing downstream changes.
 */

const isString = (value: unknown): value is string => typeof value === "string";

/** An array of strings with no holes. */
function isStringList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (let i = 0; i < value.length; i += 1) {
    if (typeof value[i] !== "string") return false;
  }
  return true;
}

/**
 * Pairs back into a map, refusing anything that is not exactly a list of
 * `[string, value]` pairs with no key twice.
 *
 * A repeated key is refused rather than resolved, last one winning or first.
 * Neither side can produce one, because both encode from a map, so a repeat
 * means the input did not come from the code that ships, and guessing which
 * value was meant would be guessing about a secret.
 *
 * The errors name positions and never a key or a value: a value is a secret,
 * and an error from the main process ends up in the renderer's log.
 */
function decodePairs<T>(pairs: unknown, what: string, isValue: (value: unknown) => value is T): Record<string, T> {
  if (!Array.isArray(pairs)) throw new TypeError(`${what} is not a list of pairs`);
  const map: Record<string, T> = Object.create(null);
  for (let i = 0; i < pairs.length; i += 1) {
    const pair: unknown = pairs[i];
    if (!Array.isArray(pair) || pair.length !== 2 || !isString(pair[0]) || !isValue(pair[1])) {
      throw new TypeError(`${what}[${i}] is not a pair of a key and a value of the right type`);
    }
    if (Object.hasOwn(map, pair[0])) throw new TypeError(`${what}[${i}] repeats a key`);
    map[pair[0]] = pair[1];
  }
  return { ...map };
}

/** An env map as pairs, in the map's own order. */
export function encodeEnv(env: Record<string, string>): EnvPairs {
  return Object.entries(env);
}

/** Pairs back into an env map. Throws on anything but `[string, string]` pairs with no key twice. */
export function decodeEnv(pairs: unknown, what = "env"): Record<string, string> {
  return decodePairs(pairs, what, isString);
}

/** `heldKeys` as pairs, in the map's own order. */
export function encodeHeldKeys(heldKeys: Record<string, string[]>): HeldKeyPairs {
  return Object.entries(heldKeys);
}

/** Pairs back into `heldKeys`. Throws on anything but `[string, string[]]` pairs with no id twice. */
export function decodeHeldKeys(pairs: unknown): Record<string, string[]> {
  return decodePairs(pairs, "heldKeys", isStringList);
}

/**
 * Servers as they cross: each `env` as pairs, in the place it held among the
 * server's fields, so nothing about the record changes but that.
 *
 * A server with no `env` crosses with none. So does one whose `env` is `null`,
 * which only a hand-edited `local-mcp.json` can hold: the panel treats it as
 * no env, and refusing it would leave a panel that cannot load.
 */
export function serversToWire(servers: LocalMcpServer[]): LocalMcpServerOnWire[] {
  return servers.map((server) => {
    if (server.env == null) {
      const { env: _absent, ...rest } = server;
      return rest;
    }
    return { ...server, env: encodeEnv(server.env) };
  });
}

/**
 * Servers back from the wire, each `env` decoded. Throws when the list is not
 * an array, when an entry is not an object, or when any `env` does not decode,
 * so a caller that runs this first has read and written nothing when it does.
 */
export function serversFromWire(servers: unknown): LocalMcpServer[] {
  if (!Array.isArray(servers)) throw new TypeError("the servers are not a list");
  const decoded: LocalMcpServer[] = [];
  for (let i = 0; i < servers.length; i += 1) {
    const server: unknown = servers[i];
    if (server === null || typeof server !== "object" || Array.isArray(server)) {
      throw new TypeError(`servers[${i}] is not a server`);
    }
    const { env } = server as { env?: unknown };
    decoded.push(
      env === undefined
        ? (server as LocalMcpServer)
        : ({ ...server, env: decodeEnv(env, `servers[${i}].env`) } as LocalMcpServer),
    );
  }
  return decoded;
}

/** What a handler returns: the answer with `env` and `heldKeys` as pairs. `ok: false` crosses as it is. */
export function replyToWire(result: McpServersResult): McpServersReply {
  if (!result.ok) return result;
  return { ok: true, servers: serversToWire(result.servers), heldKeys: encodeHeldKeys(result.heldKeys) };
}

/**
 * A handler's reply decoded for the panel, and `undefined` kept as it is: the
 * folds give an absent answer its own message.
 *
 * An absent `heldKeys` is read as none, as the folds read it before this codec
 * existed. Anything present must decode.
 */
export function replyFromWire(reply: McpServersReply | undefined): McpServersResult | undefined {
  if (!reply || !reply.ok) return reply;
  return {
    ok: true,
    servers: serversFromWire(reply.servers),
    heldKeys: reply.heldKeys === undefined ? {} : decodeHeldKeys(reply.heldKeys),
  };
}
