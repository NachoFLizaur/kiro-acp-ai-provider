import { defineConfig } from "tsup"

export default defineConfig([
  // Main library entry point
  {
    entry: ["src/index.ts"],
    format: ["cjs", "esm"],
    dts: true,
    clean: true,
    sourcemap: true,
  },
  // MCP bridge — standalone script spawned by kiro-cli
  {
    entry: ["src/mcp-bridge.ts"],
    format: ["esm"],
    dts: false,
    clean: false,
    sourcemap: true,
    banner: { js: "#!/usr/bin/env node" },
  },
])
