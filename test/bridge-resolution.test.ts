import { describe, test, expect, afterEach } from "bun:test"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"
import { ACPClient } from "../src/acp-client"

// ---------------------------------------------------------------------------
// Tests for bridge resolution: findBridgeInAncestors() and Strategy 5 helpers
//
// findBridgeInAncestors() and resolveBridgePath() are private methods.
// We test them via type casting to `any`, consistent with other tests.
// ---------------------------------------------------------------------------

/** Create a unique temp directory for each test. */
function makeTempDir(): string {
  const dir = join(tmpdir(), `bridge-test-${randomBytes(6).toString("hex")}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Create a fake mcp-bridge.js at the standard node_modules path. */
function plantBridge(baseDir: string): string {
  const bridgePath = join(
    baseDir,
    "node_modules",
    "kiro-acp-ai-provider",
    "dist",
    "mcp-bridge.js",
  )
  mkdirSync(join(baseDir, "node_modules", "kiro-acp-ai-provider", "dist"), {
    recursive: true,
  })
  writeFileSync(bridgePath, "// fake bridge")
  return bridgePath
}

describe("findBridgeInAncestors", () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best-effort cleanup */
      }
    }
    tempDirs.length = 0
  })

  /** Helper to access private methods on ACPClient. */
  function getPrivate(client: ACPClient) {
    return client as any
  }

  test("finds bridge in direct node_modules", () => {
    const root = makeTempDir()
    tempDirs.push(root)

    const expectedPath = plantBridge(root)

    const client = new ACPClient({ cwd: root })
    const result = getPrivate(client).findBridgeInAncestors(root)

    expect(result).toBe(expectedPath)
  })

  test("finds bridge in ancestor's node_modules", () => {
    const grandparent = makeTempDir()
    tempDirs.push(grandparent)

    // Plant bridge in grandparent
    const expectedPath = plantBridge(grandparent)

    // Create nested child directories (no bridge here)
    const child = join(grandparent, "packages", "my-app")
    mkdirSync(child, { recursive: true })

    const client = new ACPClient({ cwd: child })
    const result = getPrivate(client).findBridgeInAncestors(child)

    expect(result).toBe(expectedPath)
  })

  test("returns undefined when bridge is not found", () => {
    const root = makeTempDir()
    tempDirs.push(root)

    // Empty directory — no node_modules at all
    const client = new ACPClient({ cwd: root })
    const result = getPrivate(client).findBridgeInAncestors(root)

    expect(result).toBeUndefined()
  })

  test("respects maxDepth limit", () => {
    const root = makeTempDir()
    tempDirs.push(root)

    // Plant bridge at root
    plantBridge(root)

    // Create a deeply nested directory (deeper than maxDepth=2)
    const deep = join(root, "a", "b", "c", "d")
    mkdirSync(deep, { recursive: true })

    const client = new ACPClient({ cwd: deep })

    // With maxDepth=2, should NOT find bridge 4 levels up
    const notFound = getPrivate(client).findBridgeInAncestors(deep, 2)
    expect(notFound).toBeUndefined()

    // With default maxDepth (10), should find it
    const found = getPrivate(client).findBridgeInAncestors(deep)
    expect(found).toBeDefined()
  })

  test("finds bridge in Bun .bun cache directory", () => {
    const root = makeTempDir()
    tempDirs.push(root)

    // Simulate Bun's .bun cache structure
    const bunCacheEntry = join(
      root,
      "node_modules",
      ".bun",
      "kiro-acp-ai-provider@1.7.1",
      "node_modules",
      "kiro-acp-ai-provider",
      "dist",
    )
    mkdirSync(bunCacheEntry, { recursive: true })
    const bridgePath = join(bunCacheEntry, "mcp-bridge.js")
    writeFileSync(bridgePath, "// fake bridge in bun cache")

    const client = new ACPClient({ cwd: root })
    const result = getPrivate(client).findBridgeInAncestors(root)

    expect(result).toBe(bridgePath)
  })
})

describe("Strategy 5 — XDG bridge extraction", () => {
  test("resolveBridgePath throws when bridge cannot be found", () => {
    // Use a temp dir with no node_modules — all strategies should fail
    const root = join(tmpdir(), `no-bridge-${randomBytes(6).toString("hex")}`)
    mkdirSync(root, { recursive: true })

    try {
      const client = new ACPClient({ cwd: root })
      const priv = client as any

      expect(() => priv.resolveBridgePath()).toThrow(
        "Could not find mcp-bridge.js",
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
