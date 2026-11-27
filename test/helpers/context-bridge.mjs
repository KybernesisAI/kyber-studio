/**
 * A copy made the way Electron's context bridge was measured to copy
 * (KYB-700, Electron 34.5.8, sandboxed preload, context isolation on), for the
 * fake bridges in the DOM tests.
 *
 *  - Every plain object, nested ones included, becomes an ordinary object with
 *    `Object.prototype`, whatever prototype it had: a map built with
 *    `Object.create(null)` arrives re-parented.
 *  - Every own enumerable key is copied except `__proto__`, which is omitted
 *    outright whatever its value: a string, an object, `null` or a number.
 *    Nothing is polluted and no prototype is changed. `constructor`,
 *    `prototype`, `toString`, `hasOwnProperty` and `valueOf` cross as
 *    ordinary own properties, in their order.
 *  - Arrays stay arrays, element by element, so a key that is an array
 *    element crosses intact.
 *
 * Keys are defined, not assigned, so no value ever meets a setter on the copy.
 * Assigning would differ from the real bridge in the one respect that matters
 * here: an object value under `__proto__` would re-parent the copy, and the
 * real bridge does not.
 *
 * `structuredClone` is NOT this copy: it keeps an own `__proto__`, which is
 * why KYB-699's renderer tests passed while the app lost the key.
 */
export function contextBridgeCopy(value) {
  if (Array.isArray(value)) return value.map(contextBridgeCopy);
  if (value === null || typeof value !== "object") return value;
  const copy = {};
  for (const key of Object.keys(value)) {
    if (key === "__proto__") continue;
    Object.defineProperty(copy, key, {
      value: contextBridgeCopy(value[key]),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return copy;
}
