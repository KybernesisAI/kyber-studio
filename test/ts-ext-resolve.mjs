// Make the repo's own import spellings resolve under native ESM, and give the
// runtime a way to load a `.tsx`.
//
// Three jobs, all of them things tsc and esbuild do and node does not:
//
//  1. EXTENSIONLESS RELATIVE imports (`./atomicWrite`). That — not the electron
//     import — is what originally stopped main-process modules loading under
//     `node --test`.
//  2. The tsconfig PATH ALIASES, `@/*` and `@shared/*`. Until round 7 this hook
//     did not know them, so any module reaching for `@/lib/store` failed to
//     resolve; that, and not the absence of a DOM, is why no test in this repo
//     had ever loaded `Plugins.tsx`. The two maps below are the same two in
//     `tsconfig.web.json` and in `electron.vite.config.ts`, written a third
//     time because nothing here parses either file. `test/mcp-panel-dom.test.mjs`
//     drives a renderer component through both aliases and fails if they drift.
//     NOT covered: an alias added to those files and never used from a test.
//  3. `.tsx`. `--experimental-strip-types` handles `.ts` and refuses `.tsx`, so
//     JSX goes through esbuild in the `load` hook below. `.ts` is untouched and
//     still goes through node's own stripper.
//
// esbuild is an explicit devDependency rather than a transitive one reached by
// hoisting through vite, so this file's `import` names something the manifest
// actually asks for.
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";
import { transformSync } from "esbuild";

/** Repo root: this file lives in `test/`. */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The `paths` from tsconfig.web.json, longest prefix first. */
const ALIASES = [
  ["@shared/", "src/shared"],
  ["@/", "src/renderer/src"],
];

/** What an extensionless specifier is allowed to mean, in order. */
const CANDIDATES = [".ts", ".tsx", ".mjs", ".js", "/index.ts", "/index.tsx"];

function fileAt(base) {
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const suffix of CANDIDATES) {
    const candidate = `${base}${suffix}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, next) {
  for (const [prefix, dir] of ALIASES) {
    if (!specifier.startsWith(prefix)) continue;
    const hit = fileAt(resolvePath(ROOT, dir, specifier.slice(prefix.length)));
    if (hit) return next(pathToFileURL(hit).href, context);
  }
  if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    for (const suffix of [".ts", ".tsx"]) {
      const candidate = new URL(`${specifier}${suffix}`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return next(`${specifier}${suffix}`, context);
    }
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (!url.endsWith(".tsx")) return next(url, context);
  const path = fileURLToPath(url);
  // `jsx: "automatic"`, because the components here import `useState` and
  // `ReactNode` by name and never `React` itself — the classic transform would
  // emit `React.createElement` against a binding that is not in scope. This is
  // the same choice as `"jsx": "react-jsx"` in tsconfig.web.json and
  // @vitejs/plugin-react in the real build; nothing here reads either of them,
  // so a change there is NOT caught by this file.
  const { code } = transformSync(readFileSync(path, "utf8"), {
    loader: "tsx",
    format: "esm",
    jsx: "automatic",
    target: "es2022",
    sourcefile: path,
  });
  return { format: "module", source: code, shortCircuit: true };
}
