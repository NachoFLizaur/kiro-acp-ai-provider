import { mkdirSync, writeFileSync, renameSync, unlinkSync, readdirSync, statSync } from "node:fs"
import { randomBytes } from "node:crypto"
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

/**
 * Resolve the on-disk path of an agent config:
 * `<dir>/.kiro/agents/<name>[-<instanceId>].json`.
 *
 * Single source of truth for the path template; writeAgentConfig and
 * removeAgentConfig both derive from it so they can never disagree.
 */
export function agentConfigPath(dir: string, name: string, instanceId?: string): string {
  const safeName = sanitizeName(name)
  const suffix = instanceId ? `-${instanceId}` : ""
  return join(dir, ".kiro", "agents", `${safeName}${suffix}.json`)
}

/** Agent config files older than this are considered abandoned by the sweep. */
const STALE_AGENT_CONFIG_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Filename pattern for the stale sweep. Matches the DEFAULT agent name
 * (`opencode`) with an instance suffix only, so configs written under a custom
 * agent name are never touched by the sweep - by design, since the sweep
 * cannot know which custom names belong to this package.
 */
const STALE_AGENT_CONFIG_PATTERN = /^opencode-[a-zA-Z0-9_-]+\.json$/

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

/**
 * Generate a tool-less agent config for sessions that don't need MCP tools.
 * Prevents kiro-cli from trying to start a stale MCP bridge.
 */
export function generateToollessAgentConfig(options: { name?: string; prompt?: string; model?: string }): Record<string, unknown> {
  return {
    name: options.name ?? "kiro-acp",
    tools: [],
    allowedTools: [],
    includeMcpJson: false,
    mcpServers: {},
    prompt:
      options.prompt ??
      `You are a coding assistant that operates under different agent identities. Your identity, behavior, and instructions are defined by the <system_instructions> block included with each request. Always follow the latest <system_instructions> as your primary directive — they define who you are, how you behave, and what tools you should use. If no <system_instructions> are present, act as a helpful coding assistant that follows instructions precisely and uses tools proactively. If a tool call fails, retry it or try alternative approaches — do not assume a tool is permanently unavailable based on a single failure.`,
    ...(options.model ? { model: options.model } : {}),
  }
}

/**
 * Write an agent config to `.kiro/agents/<name>[-<instanceId>].json`
 * atomically (temp file + rename). Returns the path.
 *
 * After a successful write, runs a best-effort sweep of the same directory
 * (see sweepStaleAgentConfigs). The sweep never affects the file just written
 * and never causes the write to fail.
 */
export function writeAgentConfig(
  dir: string,
  name: string,
  config: Record<string, unknown>,
  instanceId?: string,
): string {
  const filePath = agentConfigPath(dir, name, instanceId)

  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 })
  renameSync(tmpPath, filePath)

  sweepStaleAgentConfigs(dirname(filePath), filePath)

  return filePath
}

/**
 * Delete the agent config written for `name` / `instanceId`, if present.
 *
 * Best-effort: a missing file, a permission error, or any other filesystem
 * failure is swallowed so callers can run this from teardown paths without
 * guarding. Uses the same path template as writeAgentConfig.
 */
export function removeAgentConfig(dir: string, name: string, instanceId?: string): void {
  try {
    unlinkSync(agentConfigPath(dir, name, instanceId))
  } catch {
    // Already gone or not removable; nothing more to do.
  }
}

/**
 * Remove abandoned agent configs from `agentsDir`.
 *
 * Safety invariant: a file is deleted only when BOTH hold -
 * 1. its name matches `opencode-*.json` (the default agent name plus an
 *    instance suffix; custom agent names are never swept), and
 * 2. its modification time is more than 7 days old.
 *
 * The age gate is what protects other live clients: every running client
 * wrote its config during the current process lifetime, far under 7 days, so
 * only files left behind by crashed or killed processes qualify. The file at
 * `keepPath` (the one just written) is always skipped as an extra guard.
 *
 * Does not recurse, does not follow other patterns, never throws.
 */
function sweepStaleAgentConfigs(agentsDir: string, keepPath: string): void {
  let entries: string[]
  try {
    entries = readdirSync(agentsDir)
  } catch {
    return
  }

  const cutoff = Date.now() - STALE_AGENT_CONFIG_MS
  for (const entry of entries) {
    if (!STALE_AGENT_CONFIG_PATTERN.test(entry)) continue
    const candidate = join(agentsDir, entry)
    if (candidate === keepPath) continue
    try {
      const info = statSync(candidate)
      if (!info.isFile() || info.mtimeMs >= cutoff) continue
      unlinkSync(candidate)
    } catch {
      // Vanished between readdir and stat, or not removable; skip it.
    }
  }
}
