import { defineConfig } from "tsup"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Plugin } from "esbuild"

/**
 * esbuild plugin that replaces the `mcp-bridge-source` module with the actual
 * bundled bridge script embedded as a string constant. This allows compiled
 * binaries (which can't access node_modules) to extract the bridge at runtime.
 */
function embedBridgePlugin(): Plugin {
  return {
    name: "embed-mcp-bridge",
    setup(build) {
      // Intercept imports of the bridge source module
      build.onResolve({ filter: /[./]mcp-bridge-source/ }, (args) => ({
        path: args.path,
        namespace: "embed-bridge",
      }))

      // Provide the actual bridge content as a virtual module
      build.onLoad({ filter: /.*/, namespace: "embed-bridge" }, () => {
        const bridgePath = join(__dirname, "dist", "mcp-bridge.js")
        try {
          const source = readFileSync(bridgePath, "utf-8")
          return {
            contents: `export const MCP_BRIDGE_SOURCE = ${JSON.stringify(source)};`,
            loader: "ts",
          }
        } catch (err) {
          if (process.env.CI) {
            return { errors: [{ text: `Bridge not found at ${bridgePath}. Ensure bridge builds before main.` }] }
          }
          // If bridge hasn't been built yet, provide undefined
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

export default defineConfig([
  // 1. MCP bridge — standalone script spawned by kiro-cli (built FIRST)
  {
    entry: ["src/mcp-bridge.ts"],
    format: ["esm"],
    dts: false,
    clean: true,
    sourcemap: true,
    banner: { js: "#!/usr/bin/env node" },
  },
  // 2. Main library entry point (built SECOND, with bridge embedded)
  {
    entry: ["src/index.ts"],
    format: ["cjs", "esm"],
    dts: true,
    clean: false,
    sourcemap: true,
    esbuildPlugins: [embedBridgePlugin()],
  },
])
