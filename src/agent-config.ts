import { mkdirSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"

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
  const mcpServerName = "opencode-tools"
  const mcpServerRef = `@${mcpServerName}`

  return {
    // Agent name — required by kiro-cli to identify this agent.
    // Without it, kiro-cli falls back to "kiro_default" with all built-in tools.
    name: options.name ?? "opencode",
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
    // Agent system prompt — guides kiro-cli's behavior with tools and responses
    prompt:
      options.prompt ??
      `You are a coding assistant integrated into the opencode editor. Follow the user's instructions precisely and use tools proactively.

Tool usage guidelines:
- Use tools immediately when needed — do not ask for permission or confirmation
- When asked to read files, use the available file reading tools
- When asked to run commands, use the bash/shell tools
- When asked to write or edit files, use the file writing tools
- When asked to search, use glob or grep tools
- Execute multi-step tasks sequentially without stopping for approval
- If a tool call fails, report the error and try an alternative approach

Response guidelines:
- Be concise and direct
- Show code changes rather than describing them
- When editing files, show the actual edits rather than explaining what you would change
- Focus on completing the task, not explaining your process`,
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
