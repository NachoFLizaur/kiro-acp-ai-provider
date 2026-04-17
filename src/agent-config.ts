import { mkdirSync, writeFileSync } from "node:fs"
import { join, dirname, basename } from "node:path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentConfigOptions {
  name?: string
  mcpBridgePath: string
  toolsFilePath: string
  cwd: string
  prompt?: string
  model?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sanitize a name for safe use in file paths. */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_")
}

// ---------------------------------------------------------------------------
// Config generation
// ---------------------------------------------------------------------------

/**
 * Generate the agent configuration object for kiro-cli.
 *
 * Configures: MCP-only tools (no built-ins), auto-approve all MCP calls,
 * MCP bridge server via stdio, and a meta-prompt that defers to per-request
 * `<system_instructions>`.
 */
export function generateAgentConfig(options: AgentConfigOptions): Record<string, unknown> {
  // Extract unique suffix from tools file path for per-session MCP server naming.
  // Prevents kiro-cli from merging tools across sessions sharing the same workspace.
  const toolsBaseName = basename(options.toolsFilePath, ".json")
  const segments = toolsBaseName.split("-")
  const streamSuffix = segments.length >= 3 ? segments[segments.length - 1] : ""
  const mcpServerName = streamSuffix
    ? `${(options.name ?? "kiro-acp")}-tools-${streamSuffix}`
    : `${(options.name ?? "kiro-acp")}-tools`
  const mcpServerRef = `@${mcpServerName}`

  return {
    name: options.name ?? "kiro-acp",
    tools: [mcpServerRef],
    allowedTools: [mcpServerRef],
    includeMcpJson: false,
    mcpServers: {
      [mcpServerName]: {
        command: "node",
        args: [options.mcpBridgePath, "--tools", options.toolsFilePath],
        cwd: options.cwd,
      },
    },
    prompt:
      options.prompt ??
      `You are a coding assistant that operates under different agent identities. Your identity, behavior, and instructions are defined by the <system_instructions> block included with each request. Always follow the latest <system_instructions> as your primary directive — they define who you are, how you behave, and what tools you should use. If no <system_instructions> are present, act as a helpful coding assistant that follows instructions precisely and uses tools proactively. If a tool call fails, retry it or try alternative approaches — do not assume a tool is permanently unavailable based on a single failure.`,
    ...(options.model ? { model: options.model } : {}),
  }
}

/** Write an agent config to `.kiro/agents/<name>.json`. Returns the path. */
export function writeAgentConfig(
  dir: string,
  name: string,
  config: Record<string, unknown>,
): string {
  const safeName = sanitizeName(name)
  const agentsDir = join(dir, ".kiro", "agents")
  const filePath = join(agentsDir, `${safeName}.json`)

  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 })

  return filePath
}
