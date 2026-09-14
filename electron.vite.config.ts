import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { "@shared": resolve("src/shared") } },
    build: { rollupOptions: { input: { index: resolve("src/main/index.ts") } } },
  },
  /**
   * CommonJS, and BUNDLED. Both halves are load-bearing, and neither is style.
   *
   * The renderer is sandboxed, so its preload runs as plain script with no ESM
   * context. `"type": "module"` would make a `.js` emit ESM, which such a
   * renderer cannot load — hence `.cjs`, spelled out rather than inferred.
   *
   * And no externalizeDepsPlugin here, unlike `main`. A sandboxed preload's
   * `require` resolves `electron` plus a few polyfilled builtins and nothing
   * else, so leaving @electron-toolkit/preload as a bare require would throw at
   * load; it has to be inlined. `electron` alone stays external, because the
   * runtime is the only thing that can provide it.
   *
   * Getting either half wrong is SILENT — see src/main/index.ts. Guarded by
   * test/renderer-sandbox.test.mjs and scripts/verify-package.mjs.
   */
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve("src/preload/index.ts") },
        external: ["electron"],
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    resolve: {
      alias: { "@": resolve("src/renderer/src"), "@shared": resolve("src/shared") },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
          orb: resolve("src/renderer/orb.html"),
        },
      },
    },
  },
});
