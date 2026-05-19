import { defineConfig } from "tsup"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Plugin } from "esbuild"

/**
 * esbuild plugin that replaces the `mcp-bridge-source` module with the actual
 * bundled bridge script embedded as a string constant. This allows compiled
 * binaries (which can't access node_modules) to extract the bridge at runtime.
 *
 * IMPORTANT: this plugin reads `dist/mcp-bridge.mjs`, which is produced by
 * `tsup.bridge.config.ts`. Run that config FIRST (see the `build` script in
 * package.json). Otherwise the bridge falls back to `undefined` and the
 * compiled binary loses the XDG-extraction path.
 */
function embedBridgePlugin(): Plugin {
  return {
    name: "embed-mcp-bridge",
    setup(build) {
      build.onResolve({ filter: /[./]mcp-bridge-source/ }, (args) => ({
        path: args.path,
        namespace: "embed-bridge",
      }))

      build.onLoad({ filter: /.*/, namespace: "embed-bridge" }, () => {
        const bridgePath = join(__dirname, "dist", "mcp-bridge.mjs")
        try {
          const source = readFileSync(bridgePath, "utf-8")
          return {
            contents: `export const MCP_BRIDGE_SOURCE = ${JSON.stringify(source)};`,
            loader: "ts",
          }
        } catch (err) {
          if (process.env.CI) {
            return { errors: [{ text: `Bridge not found at ${bridgePath}. Run \`tsup --config tsup.bridge.config.ts\` first.` }] }
          }
          console.warn(`[embed-mcp-bridge] Could not read ${bridgePath}: ${err}`)
          return {
            contents: `export const MCP_BRIDGE_SOURCE = undefined;`,
            loader: "ts",
          }
        }
      })
    },
  }
}

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  clean: false,
  sourcemap: true,
  esbuildPlugins: [embedBridgePlugin()],
})
