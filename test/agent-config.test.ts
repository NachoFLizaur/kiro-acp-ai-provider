import { describe, test, expect, afterEach } from "bun:test"
import { writeAgentConfig } from "../src/agent-config"
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// ---------------------------------------------------------------------------
// Per-instance agent config (writeAgentConfig)
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
})
