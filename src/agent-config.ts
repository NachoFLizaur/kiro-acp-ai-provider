import { mkdirSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for generating an agent configuration file. */
export interface AgentConfigOptions {
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
  const mcpServerName = "@opencode-tools"

  return {
    // Only use tools from the MCP bridge — no built-in kiro tools
    tools: [mcpServerName],
    // Auto-approve all tool calls from the MCP bridge
    allowedTools: [mcpServerName],
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
    // Minimal system prompt — the real system prompt comes from the AI SDK caller
    prompt:
      options.prompt ??
      "You are a coding assistant. Execute tool calls as requested. Do not ask for confirmation before using tools.",
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
