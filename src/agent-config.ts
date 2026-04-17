import { mkdirSync, writeFileSync } from "node:fs"
import { join, dirname, basename } from "node:path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for generating an agent configuration file. */
export interface AgentConfigOptions {
  /** Agent name used by kiro-cli to identify this agent. */
  name?: string
  /** Path to the MCP bridge script (e.g. a Node.js stdio server). */
  mcpBridgePath: string
  /** Path to the JSON file describing available tools. */
  toolsFilePath: string
  /** Working directory for the project. */
  cwd: string
  /** Custom system prompt for the agent. */
  prompt?: string
  /** Default model ID. */
  model?: string
}

// ---------------------------------------------------------------------------
// Config generation
// ---------------------------------------------------------------------------

/**
 * Generate the agent configuration object for kiro-cli.
 *
 * The config tells kiro-cli to:
 * - Use only MCP-provided tools (no built-in tools)
 * - Auto-approve all MCP tool calls
 * - Connect to the MCP bridge server via stdio
 * - Use a minimal custom prompt
 */
export function generateAgentConfig(options: AgentConfigOptions): Record<string, unknown> {
  // Extract a unique suffix from the tools file path to make the MCP server
  // name unique per session. The tools file is named like:
  //   tools-{cwdHash}-{instanceOrSessionId}.json
  // We extract the last segment before .json (the instance/session ID) and
  // append it to the server name. This prevents kiro-cli from merging tools
  // across MCP servers when multiple sessions share the same workspace.
  const toolsBaseName = basename(options.toolsFilePath, ".json") // e.g. "tools-504d74e4-760ededf"
  const segments = toolsBaseName.split("-")
  const streamSuffix = segments.length >= 3 ? segments[segments.length - 1] : ""
  const mcpServerName = streamSuffix
    ? `${(options.name ?? "kiro-acp")}-tools-${streamSuffix}`
    : `${(options.name ?? "kiro-acp")}-tools`
  const mcpServerRef = `@${mcpServerName}`

  return {
    // Agent name — required by kiro-cli to identify this agent.
    // Without it, kiro-cli falls back to "kiro_default" with all built-in tools.
    name: options.name ?? "kiro-acp",
    // Only use tools from the MCP bridge — no built-in kiro tools
    // The @-prefix references "all tools from this MCP server"
    tools: [mcpServerRef],
    // Auto-approve all tool calls from the MCP bridge
    allowedTools: [mcpServerRef],
    // Do not include the project's .kiro/mcp.json
    includeMcpJson: false,
    // MCP server configuration
    mcpServers: {
      [mcpServerName]: {
        command: "node",
        args: [options.mcpBridgePath, "--tools", options.toolsFilePath],
        cwd: options.cwd,
      },
    },
    // Agent system prompt — identity-neutral meta-prompt that defers to per-request <system_instructions>
    prompt:
      options.prompt ??
      `You are a coding assistant that operates under different agent identities. Your identity, behavior, and instructions are defined by the <system_instructions> block included with each request. Always follow the latest <system_instructions> as your primary directive — they define who you are, how you behave, and what tools you should use. If no <system_instructions> are present, act as a helpful coding assistant that follows instructions precisely and uses tools proactively. If a tool call fails, retry it or try alternative approaches — do not assume a tool is permanently unavailable based on a single failure.`,
    // Default model if specified
    ...(options.model ? { model: options.model } : {}),
  }
}

/**
 * Write an agent configuration file to `.kiro/agents/<name>.json`.
 *
 * @returns The absolute path to the written config file.
 */
export function writeAgentConfig(
  dir: string,
  name: string,
  config: Record<string, unknown>,
): string {
  const agentsDir = join(dir, ".kiro", "agents")
  const filePath = join(agentsDir, `${name}.json`)

  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8")

  return filePath
}
