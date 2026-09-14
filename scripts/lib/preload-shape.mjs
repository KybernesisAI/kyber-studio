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
 *   resolves `electron` and a small polyfilled subset of Node builtins, and
 *   NOTHING from node_modules. A bare `require("@electron-toolkit/preload")`
 *   resolves happily in development and throws in the package.
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
import { isBuiltin } from "node:module";

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
 * The known limit: a regex literal whose body opens a block comment would be
 * read as opening one. No such literal exists in this repo, and writing one
 * means escaping the star, which stops it matching here anyway.
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
 * The specifiers a sandboxed preload could not resolve: bare package names.
 *
 * `electron` is the one the runtime provides, and Node builtins (bare or
 * `node:`-prefixed) are the polyfilled subset. Relative and absolute paths are
 * not this check's business — a bundle should not have them either, but a path
 * that does not resolve fails loudly, which is a different problem from this one.
 */
export function unresolvableSpecifiers(specifiers) {
  return specifiers.filter((specifier) => {
    if (specifier === "electron") return false;
    if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
    return !isBuiltin(specifier);
  });
}

/**
 * Top-level ESM `import`/`export` statements, as written.
 *
 * Anchored to the start of a line because that is what a bundler emits and what
 * distinguishes a statement from the word appearing inside an expression —
 * `await import(...)` is legal in CommonJS and must NOT be reported, whereas
 * `import x from "y"` at column zero is the thing that makes a file ESM.
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
 */
export function inspectPreload(source) {
  return {
    usesRequire: /\brequire\s*\(/.test(withoutComments(source)),
    unresolvable: unresolvableSpecifiers(requiredSpecifiers(source)),
    esm: esmStatements(source),
  };
}
