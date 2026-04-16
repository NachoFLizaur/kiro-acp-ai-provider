import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { getSessionFilePath, persistSession, loadPersistedSession } from "../src/session-storage"

describe("session-storage", () => {
  let testDir: string
  let originalXdgDataHome: string | undefined

  beforeEach(() => {
    // Use a unique temp dir for each test
    testDir = join(tmpdir(), `session-storage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testDir, { recursive: true })
    originalXdgDataHome = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = testDir
  })

  afterEach(() => {
    // Restore env and clean up
    if (originalXdgDataHome !== undefined) {
      process.env.XDG_DATA_HOME = originalXdgDataHome
    } else {
      delete process.env.XDG_DATA_HOME
    }
    try { rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  test("getSessionFilePath returns XDG path with affinity ID", () => {
    const path = getSessionFilePath("/project", "abc123")

    // Path should end with sessions/{hash}/abc123.json
    expect(path).toMatch(/sessions\/[a-f0-9]+\/abc123\.json$/)
  })

  test("getSessionFilePath returns _default.json without affinity", () => {
    const path = getSessionFilePath("/project", undefined)

    // Path should end with sessions/{hash}/_default.json
    expect(path).toMatch(/sessions\/[a-f0-9]+\/_default\.json$/)
  })

  test("getSessionFilePath uses XDG_DATA_HOME when set", () => {
    process.env.XDG_DATA_HOME = "/custom"

    const path = getSessionFilePath("/project", "abc123")

    expect(path.startsWith("/custom/kiro-acp-ai-provider/")).toBe(true)
  })

  test("getSessionFilePath falls back to ~/.local/share", () => {
    delete process.env.XDG_DATA_HOME

    const path = getSessionFilePath("/project", "abc123")

    expect(path).toContain(".local/share/kiro-acp-ai-provider/")
  })

  test("persistSession + loadPersistedSession round-trip", () => {
    // Arrange
    const cwd = "/project/round-trip"
    const sessionId = "sess-round-trip-123"
    const affinityId = "aff-rt"

    // Act
    persistSession(cwd, sessionId, affinityId)
    const loaded = loadPersistedSession(cwd, affinityId)

    // Assert
    expect(loaded).not.toBeNull()
    expect(loaded!.kiroSessionId).toBe(sessionId)
    expect(typeof loaded!.lastUsed).toBe("number")
    expect(loaded!.lastUsed).toBeGreaterThan(0)
  })

  test("loadPersistedSession returns null for stale session", () => {
    // Arrange — persist a session, then manually overwrite with a stale timestamp
    const cwd = "/project/stale"
    const affinityId = "aff-stale"
    persistSession(cwd, "sess-stale", affinityId)

    const filePath = getSessionFilePath(cwd, affinityId)
    const staleData = {
      kiroSessionId: "sess-stale",
      lastUsed: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
    }
    writeFileSync(filePath, JSON.stringify(staleData))

    // Act
    const loaded = loadPersistedSession(cwd, affinityId)

    // Assert
    expect(loaded).toBeNull()
  })

  test("loadPersistedSession returns null for missing file", () => {
    // Arrange — use a cwd that has never been persisted
    const cwd = "/project/nonexistent-" + Date.now()

    // Act
    const loaded = loadPersistedSession(cwd, "no-such-affinity")

    // Assert
    expect(loaded).toBeNull()
  })

  test("loadPersistedSession returns null for invalid JSON", () => {
    // Arrange — persist a session, then overwrite with garbage
    const cwd = "/project/invalid-json"
    const affinityId = "aff-invalid"
    persistSession(cwd, "sess-invalid", affinityId)

    const filePath = getSessionFilePath(cwd, affinityId)
    writeFileSync(filePath, "this is not valid json {{{")

    // Act
    const loaded = loadPersistedSession(cwd, affinityId)

    // Assert
    expect(loaded).toBeNull()
  })

  test("persistSession creates directory tree", () => {
    // Arrange — use a fresh cwd that hasn't been used
    const cwd = `/project/new-dir-${Date.now()}`
    const affinityId = "aff-newdir"

    // Act
    persistSession(cwd, "sess-newdir", affinityId)

    // Assert — the file should exist and be readable
    const filePath = getSessionFilePath(cwd, affinityId)
    const raw = readFileSync(filePath, "utf-8")
    const data = JSON.parse(raw)
    expect(data.kiroSessionId).toBe("sess-newdir")
  })

  test("persisted data contains only kiroSessionId and lastUsed", () => {
    // Arrange
    const cwd = "/project/minimal-data"
    const affinityId = "aff-minimal"

    // Act
    persistSession(cwd, "sess-minimal", affinityId)

    // Assert — read raw file and check keys
    const filePath = getSessionFilePath(cwd, affinityId)
    const raw = readFileSync(filePath, "utf-8")
    const data = JSON.parse(raw)
    const keys = Object.keys(data)
    expect(keys).toHaveLength(2)
    expect(keys).toContain("kiroSessionId")
    expect(keys).toContain("lastUsed")
  })

  test("different affinity IDs produce different files", () => {
    // Arrange
    const cwd = "/project/multi-affinity"

    // Act
    const path1 = getSessionFilePath(cwd, "affinity-a")
    const path2 = getSessionFilePath(cwd, "affinity-b")

    // Assert
    expect(path1).not.toBe(path2)
    expect(path1).toContain("affinity-a.json")
    expect(path2).toContain("affinity-b.json")
  })
})
