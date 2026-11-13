/**
 * The message inside Electron's IPC wrapping of a main-process exception.
 *
 * A handler that throws reaches the renderer as
 *
 *   Error invoking remote method 'studio:<channel>': <Name>: <message>
 *
 * which names an internal channel and an exception class, neither of which a
 * person can act on. This returns `<message>`. A string without the wrapper is
 * returned with only a leading `<Name>Error: ` removed.
 */
export function ipcInnerMessage(raw: string): string {
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^[A-Za-z]*Error:\s*/, "");
}
