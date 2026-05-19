// ---------------------------------------------------------------------------
// MCP Bridge — Embedded Source
// ---------------------------------------------------------------------------
// This file is a build-time placeholder. During the tsup build, an esbuild
// plugin replaces imports of this module with the actual bundled contents of
// mcp-bridge.mjs (as a string constant). This allows compiled binaries to
// extract the bridge script without needing it on the filesystem.
//
// At development time (ts-node, tsx, bun --watch, etc.) this module returns
// undefined, which signals that the embedded source is not available and the
// caller should use other resolution strategies.
// ---------------------------------------------------------------------------

/** Embedded mcp-bridge.mjs source (available only in production builds). */
export const MCP_BRIDGE_SOURCE: string | undefined = undefined
