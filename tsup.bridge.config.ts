import { defineConfig } from "tsup"

/**
 * Build configuration for the standalone MCP bridge script.
 *
 * The bridge is built FIRST and emitted as `dist/mcp-bridge.mjs`. The `.mjs`
 * extension is required so Node treats the file as ESM regardless of the
 * surrounding directory's `package.json` — important for the XDG fallback
 * path used in compiled binaries, where the bridge is extracted into a
 * directory with no `package.json`.
 *
 * After this config runs, `tsup.config.ts` runs and embeds the bridge's
 * source as a string constant in the main library bundle.
 */
export default defineConfig({
  entry: ["src/mcp-bridge.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  outExtension: () => ({ js: ".mjs" }),
  banner: { js: "#!/usr/bin/env node" },
})
