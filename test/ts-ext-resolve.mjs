// Resolve the repo's extensionless relative imports (`./atomicWrite`) for
// native ESM. tsc and esbuild both do this; node does not, and that — not the
// electron import — is what actually stopped main-process modules loading
// under `node --test`. No dependency: node:module, node:fs, node:url.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return next(`${specifier}.ts`, context);
  }
  return next(specifier, context);
}
