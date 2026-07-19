import { describe, test, expect, afterEach } from "bun:test"
import { generateAgentConfig, writeAgentConfig } from "../src/agent-config"
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// ---------------------------------------------------------------------------
// Tests for Task 05: Per-Instance Agent Config
// ---------------------------------------------------------------------------

describe("writeAgentConfig", () => {
  const tempDirs: string[] = []

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "agent-config-test-"))
    tempDirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    }
    tempDirs.length = 0
  })

  test("writeAgentConfig without instanceId uses plain name", () => {
    // Arrange
    const dir = makeTempDir()
    const config = { name: "opencode", tools: [] }

    // Act
    const result = writeAgentConfig(dir, "opencode", config)

    // Assert
    const expected = join(dir, ".kiro", "agents", "opencode.json")
    expect(result).toBe(expected)
    expect(existsSync(expected)).toBe(true)
  })

  test("writeAgentConfig with instanceId uses suffixed name", () => {
    // Arrange
    const dir = makeTempDir()
    const config = { name: "opencode", tools: [] }

    // Act
    const result = writeAgentConfig(dir, "opencode", config, "a1b2c3d4")

    // Assert
    const expected = join(dir, ".kiro", "agents", "opencode-a1b2c3d4.json")
    expect(result).toBe(expected)
    expect(existsSync(expected)).toBe(true)
  })

  test("writeAgentConfig content is valid JSON", () => {
    // Arrange
    const dir = makeTempDir()
    const config = {
      name: "opencode",
      tools: ["@opencode-tools"],
      allowedTools: ["@opencode-tools"],
      mcpServers: { "opencode-tools": { command: "node", args: ["bridge.js"] } },
    }

    // Act
    const filePath = writeAgentConfig(dir, "opencode", config)

    // Assert
    const raw = readFileSync(filePath, "utf-8")
    const parsed = JSON.parse(raw)
    expect(parsed.name).toBe("opencode")
    expect(parsed.tools).toEqual(["@opencode-tools"])
    expect(parsed.mcpServers).toBeDefined()
    expect(parsed.mcpServers["opencode-tools"]).toBeDefined()
  })

  test("writeAgentConfig creates .kiro/agents directory", () => {
    // Arrange
    const dir = makeTempDir()
    const agentsDir = join(dir, ".kiro", "agents")
    expect(existsSync(agentsDir)).toBe(false)

    // Act
    writeAgentConfig(dir, "opencode", { name: "opencode" })

    // Assert
    expect(existsSync(agentsDir)).toBe(true)
    const stat = statSync(agentsDir)
    expect(stat.isDirectory()).toBe(true)
  })

  test("generateAgentConfig exposes stable aliases for server-qualified MCP tools", () => {
    const dir = makeTempDir()
    const toolsFilePath = join(dir, "tools-deadbeef-760ededf.json")
    writeFileSync(toolsFilePath, JSON.stringify({
      tools: [
        { name: "agent_teams_readiness_echo" },
        { name: "agent_teams_task_complete" },
      ],
    }))

    const config = generateAgentConfig({
      name: "opencode",
      mcpBridgePath: "/tmp/mcp-bridge.mjs",
      toolsFilePath,
      cwd: dir,
    })

    expect(config.toolAliases).toEqual({
      "@kacp_760ededf/agent_teams_readiness_echo": "agent_teams_readiness_echo",
      "@kacp_760ededf/agent_teams_task_complete": "agent_teams_task_complete",
    })
    expect(config.tools).toEqual([
      "@kacp_760ededf/agent_teams_readiness_echo",
      "@kacp_760ededf/agent_teams_task_complete",
    ])
    expect(config.allowedTools).toEqual(config.tools)
  })
})
