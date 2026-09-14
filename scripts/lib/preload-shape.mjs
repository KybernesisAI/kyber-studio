/**
 * What a preload IS, read from its text.
 *
 * @remarks
 * The renderer is sandboxed (KYB-569), and that puts two hard constraints on
 * the preload which nothing in the source tree can show you:
 *
 * - it must be CommonJS. A sandboxed preload is run as plain script with no ESM
 *   context, and `"type": "module"` makes a `.js` file ESM — so the emitted
 *   file has to be `.cjs` and has to contain no top-level `import`.
 * - every package it uses must be BUNDLED IN. A sandboxed preload's `require`
 *   resolves `electron` and the three builtins Electron polyfills — `events`,
 *   `timers`, `url` — and NOTHING else: no other builtin, and nothing from
 *   node_modules. A bare `require("@electron-toolkit/preload")` resolves
 *   happily in development and throws in the package.
 *
 * Both failures are silent in the way that matters: the context bridge never
 * attaches, `window.studio` is undefined everywhere, and the app looks SIGNED
 * OUT rather than broken. Nothing reaches a log — Electron does emit
 * `preload-error` on the WebContents, and nothing in this app listens.
 *
 * This file exists for the same reason scripts/lib/native-arch.mjs does, and by
 * the same rule (KYB-551): `verify-package.mjs` is a script that needs a real
 * bundle and calls `process.exit`, so importing it from a test runs it. The
 * measuring lives here, the bookkeeping and the shouting stay there, and
 * test/renderer-sandbox.test.mjs can exercise all of this against strings.
 *
 * Text, not a parser. These functions are deliberately not an ESM/CJS analysis:
 * they are shape checks over generated bundle output, which is regular in a way
 * hand-written source is not. `withoutComments` is the one piece of real
 * lexing, and it is here because the alternative — matching a rule's own
 * documentation as though it were code — is a false positive that would be
 * blamed on the check rather than on the regex.
 */

/**
 * Source with comments removed and everything else left where it was.
 *
 * A character walk rather than a regex, because the strings matter: a URL in a
 * string literal contains `//`, and stripping from there would delete the rest
 * of the line. Single, double and template quotes are tracked, with escapes.
 *
 * Newlines inside removed comments are KEPT, so line numbers still line up with
 * the file on disk — a guard that names the wrong line is a guard people learn
 * to distrust.
 *
 * Regex literals are not tracked as a lexical state. That used to cost a line
 * of live code per URL-scheme regex; one of the two holes is now closed.
 *
 * - CLOSED — a regex whose body contains `//`, as `const re = /^https?:\/\//;`
 *   does. It was read as opening a line comment and the REST OF THAT LINE was
 *   deleted, live code included. Not exotic either: URL-scheme regexes are
 *   ordinary in an Electron main process, around `will-navigate` and
 *   `setWindowOpenHandler`. The closure is one rule — OUTSIDE a string, a
 *   backslash escapes whatever follows it — so each `\/` is consumed as a pair
 *   and the two slashes never become adjacent. It costs nothing elsewhere: a
 *   backslash outside a string has no other use in JavaScript, and both
 *   characters are still written to the output, so nothing shifts.
 * - OPEN — a regex whose body opens a block comment would still be read as
 *   opening one. Writing that means escaping the star, which stops the regex
 *   matching here anyway, so it stays documented rather than closed.
 *
 * The consequence of the remaining limit is a check that reads LESS code than
 * the file contains, so it can miss a violation on such a line. It cannot
 * invent one, which is the direction that would get this guard distrusted.
 */
export function withoutComments(source) {
  let out = "";
  let i = 0;
  let quote = null; // the closing character we are looking for, or null

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (quote) {
      if (c === "\\") {
        out += c + (next ?? "");
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i += 1;
      continue;
    }

    // Outside a string, a backslash escapes the next character. In practice
    // that means a regex literal's body: consuming `\/` as a pair is what
    // stops `/^https?:\/\//` reading as a line comment.
    if (c === "\\") {
      out += c + (next ?? "");
      i += 2;
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }

    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }

    if (c === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
      continue;
    }

    out += c;
    i += 1;
  }

  return out;
}

/** Every specifier passed to a literal `require("…")`, in source order. */
export function requiredSpecifiers(source) {
  const found = [];
  const pattern = /\brequire\s*\(\s*(["'])([^"'\n]*)\1\s*\)/g;
  for (const match of withoutComments(source).matchAll(pattern)) found.push(match[2]);
  return found;
}

/**
 * Everything a sandboxed preload can resolve, and it is a SHORT list.
 *
 * `electron` comes from the runtime. Electron polyfills exactly three Node
 * builtins for a sandboxed preload — `events`, `timers` and `url` — in bare and
 * `node:`-prefixed form. Nothing else is there: not `fs`, not `path`, not
 * `crypto`, not `os`, not `child_process`, however plainly built in they are.
 *
 * `electron/common` and `electron/renderer` are here on a SOURCE-LEVEL fact,
 * and this note exists so that nobody removes them after checking the docs.
 * Electron's docs/tutorial/sandbox.md lists only `electron` (:49) — but
 * lib/sandboxed_renderer/init.ts seeds the loader's map with all three, each
 * bound to the same module object (34.5.8, :48-54):
 *
 *     const loadedModules = new Map([
 *       ['electron', electron],
 *       ['electron/common', electron],
 *       ['electron/renderer', electron],
 *       ['events', events], ['node:events', events],
 *     ]);
 *
 * They matter here rather than in theory: electron-vite's preload preset
 * externalises `/^electron\/.+/` (3.1.0, dist/chunks/lib-DyJQBCfr.mjs:391), so
 * `import { ipcRenderer } from "electron/renderer"` arrives in the bundle as a
 * bare require. Rejecting it would fail a build over a preload that loads.
 *
 * What is deliberately NOT here:
 *
 * - `process`. It is not a module. init.ts passes it into the preload wrapper
 *   as a GLOBAL alongside `require` and `Buffer`, and the loader's require
 *   throws for anything outside the two maps — so `require("process")` fails.
 * - `node:timers/promises`. init.ts registers `timers` and `node:timers` only
 *   (:56-61); the promises subpath is not in either map.
 */
const RESOLVABLE = new Set([
  "electron",
  "electron/common",
  "electron/renderer",
  "events",
  "node:events",
  "timers",
  "node:timers",
  "url",
  "node:url",
]);

/**
 * The specifiers a sandboxed preload could not resolve.
 *
 * Checked against an explicit allowlist and NOT against `isBuiltin`, which was
 * the first version of this and was wrong in the one direction that matters: it
 * waved through every Node builtin, and only three of them exist here.
 *
 * That hole is reachable through this build rather than hypothetical.
 * electron-vite's preload preset sets `external: ['electron', /^electron\/.+/,
 * ...builtinModules.flatMap(m => [m, `node:${m}`])]`, and vite's `mergeConfig`
 * CONCATENATES arrays rather than replacing them — so the `external:
 * ["electron"]` in electron.vite.config.ts narrows that to nothing. The first
 * person to write `import { join } from "node:path"` in the preload gets a bare
 * `require("node:path")` in the bundle; with a builtin check both guards pass it
 * green and it fails at load, silently, in the way described above.
 *
 * The allowlist errs the other way. A specifier that is genuinely fine but not
 * listed fails the build loudly, in CI, with the specifier named — which is a
 * five-minute correction here rather than an app that looks signed out.
 *
 * Relative and absolute paths are not this check's business — a bundle should
 * not have them either, but a path that does not resolve fails loudly, which is
 * a different problem from this one.
 */
export function unresolvableSpecifiers(specifiers) {
  return specifiers.filter((specifier) => {
    if (RESOLVABLE.has(specifier)) return false;
    if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
    return true;
  });
}

/**
 * Top-level ESM `import`/`export` statements, as written.
 *
 * Anchored to the start of a line because that is what a bundler emits and what
 * distinguishes a statement from the word appearing inside an expression —
 * `await import(...)` is legal in CommonJS and must NOT be reported, whereas
 * `import x from "y"` at column zero is the thing that makes a file ESM.
 *
 * The known limits, worth having written down rather than discovered by someone
 * reading a green run. All three patterns are single-line and space-sensitive,
 * so each of these is ESM and returns `[]` here:
 *
 * - a multi-line specifier list — `import {\n  x\n} from "y";`
 * - minified output with no spaces — `import{contextBridge}from"electron";`
 * - a bare re-export — `export{a as b};` (the export pattern requires at least
 *   one space after `export`, before the `{`)
 *
 * This is acceptable only because of what the input is: rollup, building THIS
 * bundle, emits none of those shapes — `minify: false` in electron-vite's
 * preload preset, a cjs output format, and one entry. It is a shape check over
 * generated output, not an ESM parser, and it stops being sound the moment it
 * is pointed at hand-written or minified source. `inspectPreload`'s
 * `usesRequire` is the backstop for a miss here, and it is a weak one — see
 * there.
 */
export function esmStatements(source) {
  const found = [];
  const patterns = [
    /^[ \t]*import[ \t]+[^\n(]*from[ \t]*["'][^"'\n]*["']/gm, // import x from "y"
    /^[ \t]*import[ \t]*["'][^"'\n]*["']/gm, //                    import "y"
    /^[ \t]*export[ \t]+(?:default|const|let|var|function|class|\{|\*)/gm,
  ];
  for (const pattern of patterns) {
    for (const match of withoutComments(source).matchAll(pattern)) found.push(match[0].trim());
  }
  return found;
}

/**
 * The whole verdict on one preload's text, so the caller does bookkeeping and
 * not judgement. Deliberately returns findings rather than a boolean: the
 * failure message has to name the offending specifier or statement, or whoever
 * reads it learns only that something is wrong.
 *
 * `usesRequire` is a weak signal and is treated as one. Strings are not stripped
 * by `withoutComments` — deliberately, since a URL in one must survive — so the
 * two-word sequence `require(` satisfies it from anywhere, a string literal or a
 * log message included. It catches a preload that is ESM through and through; it
 * would not catch an ESM preload that happens to mention require in a message.
 * The load-bearing checks are `esm` and `unresolvable`.
 */
export function inspectPreload(source) {
  return {
    usesRequire: /\brequire\s*\(/.test(withoutComments(source)),
    unresolvable: unresolvableSpecifiers(requiredSpecifiers(source)),
    esm: esmStatements(source),
  };
}
