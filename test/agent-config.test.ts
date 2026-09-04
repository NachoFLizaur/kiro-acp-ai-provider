import { describe, test, expect, afterEach } from "bun:test"
import { writeAgentConfig, removeAgentConfig, agentConfigPath } from "../src/agent-config"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  statSync,
  utimesSync,
  chmodSync,
  readdirSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const DAY_MS = 24 * 60 * 60 * 1000

/** Create `path` with the given content and back-date its modification time. */
function writeAged(path: string, ageMs: number, content = "{}"): void {
  writeFileSync(path, content)
  const when = new Date(Date.now() - ageMs)
  utimesSync(path, when, when)
}

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

  describe("stale config sweep", () => {
    test("removes only opencode-*.json files older than seven days", () => {
      // Arrange
      const dir = makeTempDir()
      const agentsDir = join(dir, ".kiro", "agents")
      mkdirSync(agentsDir, { recursive: true })
      const staleMatching = join(agentsDir, "opencode-deadbeef.json")
      const freshMatching = join(agentsDir, "opencode-cafebabe.json")
      const justUnderCutoff = join(agentsDir, "opencode-00000001.json")
      const staleCustomName = join(agentsDir, "my-agent-deadbeef.json")
      const staleNoSuffix = join(agentsDir, "opencode.json")
      const stalePrefixed = join(agentsDir, "old-opencode-deadbeef.json")
      const staleWrongExtension = join(agentsDir, "opencode-deadbeef.json.bak")
      const staleDirectory = join(agentsDir, "opencode-directory.json")
      writeAged(staleMatching, 8 * DAY_MS)
      writeAged(freshMatching, 1 * DAY_MS)
      writeAged(justUnderCutoff, 7 * DAY_MS - 60_000)
      writeAged(staleCustomName, 30 * DAY_MS)
      writeAged(staleNoSuffix, 30 * DAY_MS)
      writeAged(stalePrefixed, 30 * DAY_MS)
      writeAged(staleWrongExtension, 30 * DAY_MS)
      mkdirSync(staleDirectory)
      const old = new Date(Date.now() - 30 * DAY_MS)
      utimesSync(staleDirectory, old, old)

      // Act
      const written = writeAgentConfig(dir, "opencode", { name: "opencode" }, "a1b2c3d4")

      // Assert: the one stale match is gone; everything else survives
      expect(existsSync(staleMatching)).toBe(false)
      expect(existsSync(freshMatching)).toBe(true)
      expect(existsSync(justUnderCutoff)).toBe(true)
      expect(existsSync(staleCustomName)).toBe(true)
      expect(existsSync(staleNoSuffix)).toBe(true)
      expect(existsSync(stalePrefixed)).toBe(true)
      expect(existsSync(staleWrongExtension)).toBe(true)
      expect(existsSync(staleDirectory)).toBe(true)
      expect(existsSync(written)).toBe(true)
    })

    test("leaves files of other live clients alone when nothing is stale", () => {
      // Arrange: three clients sharing one working directory
      const dir = makeTempDir()
      const a = writeAgentConfig(dir, "opencode", { name: "a" }, "aaaaaaaa")
      const b = writeAgentConfig(dir, "opencode", { name: "b" }, "bbbbbbbb")

      // Act
      const c = writeAgentConfig(dir, "opencode", { name: "c" }, "cccccccc")

      // Assert
      expect(readdirSync(join(dir, ".kiro", "agents")).sort()).toEqual(
        ["opencode-aaaaaaaa.json", "opencode-bbbbbbbb.json", "opencode-cccccccc.json"],
      )
      expect(JSON.parse(readFileSync(a, "utf-8")).name).toBe("a")
      expect(JSON.parse(readFileSync(b, "utf-8")).name).toBe("b")
      expect(JSON.parse(readFileSync(c, "utf-8")).name).toBe("c")
    })

    test("does not sweep under a custom agent name even when its own files are stale", () => {
      // Arrange
      const dir = makeTempDir()
      const agentsDir = join(dir, ".kiro", "agents")
      mkdirSync(agentsDir, { recursive: true })
      const staleCustom = join(agentsDir, "my-agent-deadbeef.json")
      writeAged(staleCustom, 30 * DAY_MS)

      // Act
      writeAgentConfig(dir, "my-agent", { name: "my-agent" }, "a1b2c3d4")

      // Assert
      expect(existsSync(staleCustom)).toBe(true)
    })

    test("the write still succeeds when the directory cannot be listed", () => {
      if (process.getuid?.() === 0) return // root ignores mode bits
      // Arrange: write and traverse allowed, listing denied
      const dir = makeTempDir()
      const agentsDir = join(dir, ".kiro", "agents")
      mkdirSync(agentsDir, { recursive: true })
      chmodSync(agentsDir, 0o300)

      try {
        // Act
        const written = writeAgentConfig(dir, "opencode", { name: "opencode" }, "a1b2c3d4")

        // Assert
        expect(existsSync(written)).toBe(true)
      } finally {
        chmodSync(agentsDir, 0o700)
      }
    })
  })
})

// ---------------------------------------------------------------------------
// removeAgentConfig / agentConfigPath
// ---------------------------------------------------------------------------

describe("removeAgentConfig", () => {
  const tempDirs: string[] = []

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "agent-config-test-"))
    tempDirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
    tempDirs.length = 0
  })

  test("deletes exactly the config written for the same name and instance id", () => {
    // Arrange
    const dir = makeTempDir()
    const mine = writeAgentConfig(dir, "opencode", { name: "mine" }, "aaaaaaaa")
    const other = writeAgentConfig(dir, "opencode", { name: "other" }, "bbbbbbbb")
    const plain = writeAgentConfig(dir, "opencode", { name: "plain" })

    // Act
    removeAgentConfig(dir, "opencode", "aaaaaaaa")

    // Assert
    expect(existsSync(mine)).toBe(false)
    expect(existsSync(other)).toBe(true)
    expect(existsSync(plain)).toBe(true)
  })

  test("does not throw when the file is already gone", () => {
    const dir = makeTempDir()

    expect(() => removeAgentConfig(dir, "opencode", "deadbeef")).not.toThrow()
    expect(() => removeAgentConfig(join(dir, "missing"), "opencode")).not.toThrow()
  })

  test("agentConfigPath matches the path writeAgentConfig returns, including name sanitizing", () => {
    const dir = makeTempDir()

    const written = writeAgentConfig(dir, "my agent/x", { name: "x" }, "a1b2c3d4")

    expect(agentConfigPath(dir, "my agent/x", "a1b2c3d4")).toBe(written)
    expect(written).toBe(join(dir, ".kiro", "agents", "my_agent_x-a1b2c3d4.json"))
    expect(agentConfigPath(dir, "opencode")).toBe(join(dir, ".kiro", "agents", "opencode.json"))
  })
})
