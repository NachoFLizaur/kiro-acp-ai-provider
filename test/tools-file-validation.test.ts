import { describe, test, expect, afterEach } from "bun:test"
import { KiroACPLanguageModel, type KiroACPModelConfig } from "../src/kiro-acp-model"
import { KiroACPError } from "../src/acp-client"
import type { ACPClient, ACPSession, PromptOptions } from "../src/acp-client"
import type { IPCServer, PendingToolCall } from "../src/ipc-server"
import { LaneRouter } from "../src/lane-router"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, renameSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"
import type { LanguageModelV3FunctionTool, LanguageModelV3CallOptions, LanguageModelV3Prompt, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { mock } from "bun:test"

// ---------------------------------------------------------------------------
// Tools file validation (ensureToolsFileReady)
//
// ensureToolsFileReady() is a private method on KiroACPLanguageModel.
// It is exercised by creating a model with a mock client and calling doStream()
// with tools, which triggers acquireSession() -> ensureToolsFileReady().
//
// The key insight: createSessionToolsFilePath returns a path we control,
// so we can pre-populate or corrupt the tools file before doStream reads it.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockIPCServer(overrides: Partial<IPCServer> = {}): IPCServer {
  return {
    start: mock(() => Promise.resolve(0)),
    stop: mock(() => Promise.resolve()),
    getPort: mock(() => null),
    getPendingCount: mock(() => 0),
    getLaneRouter: mock(() => new LaneRouter()),
    resolveToolResult: mock(() => {}),
    ...overrides,
  }
}

function createMockClient(overrides: Partial<ACPClient> = {}): ACPClient {
  const mockLaneRouter = new LaneRouter()
  // Real promise-chain mutex (mirrors ACPClient.withEnsureClientLock) so that
  // ensureClient() serializes concurrent callers in tests just like production.
  let ensureClientLock: Promise<void> = Promise.resolve()
  return {
    startedToolless: false,
    withEnsureClientLock: mock(async <T,>(fn: () => Promise<T>): Promise<T> => {
      const previousLock = ensureClientLock
      let releaseLock!: () => void
      ensureClientLock = new Promise<void>((resolve) => {
        releaseLock = resolve
      })
      try {
        await previousLock
        return await fn()
      } finally {
        releaseLock()
      }
    }),
    isRunning: mock(() => false),
    start: mock(() =>
      Promise.resolve({
        agentInfo: { name: "kiro-cli", version: "1.0.0" },
        agentCapabilities: {},
      }),
    ),
    stop: mock(() => Promise.resolve()),
    createSession: mock(() =>
      Promise.resolve({
        sessionId: "sess-1",
        modes: { currentModeId: "agent", availableModes: [] },
        models: { currentModelId: "claude-sonnet-4.6", availableModels: [] },
      } satisfies ACPSession),
    ),
    createSessionWithToolsPath: mock(() =>
      Promise.resolve({
        sessionId: "sess-1",
        modes: { currentModeId: "agent", availableModes: [] },
        models: { currentModelId: "claude-sonnet-4.6", availableModels: [] },
      } satisfies ACPSession),
    ),
    loadSession: mock(() => Promise.resolve({} as ACPSession)),
    prompt: mock(async (opts: PromptOptions) => {
      opts.onUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { text: "done" },
      })
      return { stopReason: "end_turn" }
    }),
    setModel: mock(() => Promise.resolve()),
    setMode: mock(() => Promise.resolve()),
    executeCommand: mock(() =>
      Promise.resolve({ success: true, message: "ok" }),
    ),
    getMetadata: mock(() => undefined),
    getStderr: mock(() => ""),
    getToolsFilePath: mock(() => null),
    getCwd: mock(() => "/tmp/test"),
    getAgentName: mock(() => undefined),
    getIpcPort: mock(() => 12345),
    getIpcSecret: mock(() => "test-secret"),
    getIPCServer: mock(() => createMockIPCServer()),
    getLaneRouter: mock(() => mockLaneRouter),
    setPromptCallback: mock(() => {}),
    waitForToolsReady: mock(() => Promise.resolve()),
    getOrCreateToolsFilePath: mock(() => "/tmp/tools.json"),
    createSessionToolsFilePath: mock((id: string) => `/tmp/kiro-acp/tools-test-${id}.json`),
    removeSessionToolsFile: mock(() => {}),
    ...overrides,
  } as unknown as ACPClient
}

async function collectStream(
  stream: ReadableStream<LanguageModelV3StreamPart>,
): Promise<LanguageModelV3StreamPart[]> {
  const parts: LanguageModelV3StreamPart[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return parts
}

const sampleTools: LanguageModelV3FunctionTool[] = [
  {
    type: "function",
    name: "bash",
    description: "Execute a bash command",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string", description: "The command" } },
      required: ["command"],
    },
  },
  {
    type: "function",
    name: "read",
    description: "Read a file",
    inputSchema: {
      type: "object",
      properties: { filePath: { type: "string", description: "Path" } },
      required: ["filePath"],
    },
  },
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ensureToolsFileReady (tools file validation)", () => {
  const tempDirs: string[] = []

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "tools-validation-test-"))
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

  test("passes when tools file has all tools and correct IPC", async () => {
    // Arrange: create a valid tools file
    const dir = makeTempDir()
    const toolsFile = join(dir, "tools.json")

    const client = createMockClient({
      createSessionToolsFilePath: mock(() => toolsFile),
      getCwd: mock(() => "/tmp/project"),
      getIpcPort: mock(() => 12345),
      getIpcSecret: mock(() => "test-secret"),
    } as unknown as Partial<ACPClient>)

    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

    // Act: doStream with tools triggers writeToolsToFile + ensureToolsFileReady
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: sampleTools,
    } as LanguageModelV3CallOptions)
    const parts = await collectStream(result.stream)

    // Assert: no error, stream completes normally
    const errorPart = parts.find((p) => p.type === "error")
    expect(errorPart).toBeUndefined()

    const finishPart = parts.find((p) => p.type === "finish")
    expect(finishPart).toBeDefined()

    // Verify the tools file was written correctly
    const raw = readFileSync(toolsFile, "utf-8")
    const parsed = JSON.parse(raw)
    expect(parsed.tools).toHaveLength(2)
    expect(parsed.ipcPort).toBe(12345)
    expect(parsed.ipcSecret).toBe("test-secret")
  })

  test("detects missing tool definitions", async () => {
    // Arrange: create a tools file that will be overwritten with missing tools
    const dir = makeTempDir()
    const toolsFile = join(dir, "tools.json")

    // We need to intercept the writeToolsToFile call to corrupt the file
    // after the first write but before validation.
    // Strategy: use a custom createSessionToolsFilePath that returns our path,
    // and the model's writeToolsToFile will write correctly. Then ensureToolsFileReady
    // validates it. Since writeToolsToFile writes all tools, validation should pass.
    // To test the repair path, we need to corrupt the file between write and validate.
    //
    // Alternative: test the private method directly via type casting.
    const client = createMockClient({
      createSessionToolsFilePath: mock(() => toolsFile),
      getCwd: mock(() => "/tmp/project"),
      getIpcPort: mock(() => 12345),
      getIpcSecret: mock(() => "test-secret"),
    } as unknown as Partial<ACPClient>)

    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })
    const priv = model as any

    // Ensure client is "running" so ensureClient doesn't try to start
    ;(client.isRunning as any).mockImplementation(() => true)

    // Write a file with missing tools
    writeFileSync(toolsFile, JSON.stringify({
      tools: [{ name: "bash", description: "Execute", inputSchema: { type: "object", properties: {} } }],
      cwd: "/tmp/project",
      ipcPort: 12345,
      ipcSecret: "test-secret",
    }))

    // Act: call ensureToolsFileReady directly — it should detect missing "read" tool and repair
    priv.ensureToolsFileReady(toolsFile, sampleTools)

    // Assert: after repair, file should have both tools
    const raw = readFileSync(toolsFile, "utf-8")
    const parsed = JSON.parse(raw)
    expect(parsed.tools).toHaveLength(2)
    const names = parsed.tools.map((t: any) => t.name)
    expect(names).toContain("bash")
    expect(names).toContain("read")
  })

  test("detects ipcPort mismatch", async () => {
    // Arrange
    const dir = makeTempDir()
    const toolsFile = join(dir, "tools.json")

    const client = createMockClient({
      createSessionToolsFilePath: mock(() => toolsFile),
      getCwd: mock(() => "/tmp/project"),
      getIpcPort: mock(() => 99999),
      getIpcSecret: mock(() => "test-secret"),
    } as unknown as Partial<ACPClient>)

    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })
    const priv = model as any

    // Write a file with wrong ipcPort
    writeFileSync(toolsFile, JSON.stringify({
      tools: [
        { name: "bash", description: "Execute", inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
        { name: "read", description: "Read", inputSchema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } },
      ],
      cwd: "/tmp/project",
      ipcPort: 11111, // Wrong port
      ipcSecret: "test-secret",
    }))

    // Act: ensureToolsFileReady should detect mismatch and repair
    priv.ensureToolsFileReady(toolsFile, sampleTools)

    // Assert: after repair, ipcPort should be correct
    const raw = readFileSync(toolsFile, "utf-8")
    const parsed = JSON.parse(raw)
    expect(parsed.ipcPort).toBe(99999)
  })

  test("detects ipcSecret mismatch", async () => {
    // Arrange
    const dir = makeTempDir()
    const toolsFile = join(dir, "tools.json")

    const client = createMockClient({
      createSessionToolsFilePath: mock(() => toolsFile),
      getCwd: mock(() => "/tmp/project"),
      getIpcPort: mock(() => 12345),
      getIpcSecret: mock(() => "correct-secret"),
    } as unknown as Partial<ACPClient>)

    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })
    const priv = model as any

    // Write a file with wrong ipcSecret
    writeFileSync(toolsFile, JSON.stringify({
      tools: [
        { name: "bash", description: "Execute", inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
        { name: "read", description: "Read", inputSchema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } },
      ],
      cwd: "/tmp/project",
      ipcPort: 12345,
      ipcSecret: "wrong-secret", // Wrong secret
    }))

    // Act
    priv.ensureToolsFileReady(toolsFile, sampleTools)

    // Assert: after repair, ipcSecret should be correct
    const raw = readFileSync(toolsFile, "utf-8")
    const parsed = JSON.parse(raw)
    expect(parsed.ipcSecret).toBe("correct-secret")
  })

  test("repairs by rewriting tools file", async () => {
    // Arrange
    const dir = makeTempDir()
    const toolsFile = join(dir, "tools.json")

    const client = createMockClient({
      createSessionToolsFilePath: mock(() => toolsFile),
      getCwd: mock(() => "/tmp/project"),
      getIpcPort: mock(() => 12345),
      getIpcSecret: mock(() => "test-secret"),
    } as unknown as Partial<ACPClient>)

    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })
    const priv = model as any

    // Write a stale file (missing tools, wrong IPC)
    writeFileSync(toolsFile, JSON.stringify({
      tools: [],
      cwd: "/tmp/old-project",
      ipcPort: 0,
      ipcSecret: "old-secret",
    }))

    // Act
    priv.ensureToolsFileReady(toolsFile, sampleTools)

    // Assert: file should be fully repaired
    const raw = readFileSync(toolsFile, "utf-8")
    const parsed = JSON.parse(raw)
    expect(parsed.tools).toHaveLength(2)
    expect(parsed.cwd).toBe("/tmp/project")
    expect(parsed.ipcPort).toBe(12345)
    expect(parsed.ipcSecret).toBe("test-secret")
  })

  test("throws KiroACPError after failed repair", () => {
    // Arrange: create a scenario where repair also fails.
    // We do this by making the tools file path point to a directory (unwritable as file).
    const dir = makeTempDir()
    const toolsFile = join(dir, "tools.json")

    // Create a mock client where getCwd returns a path, but writeToolsToFile
    // will fail because we make the file unwritable after first validation.
    const client = createMockClient({
      createSessionToolsFilePath: mock(() => toolsFile),
      getCwd: mock(() => "/tmp/project"),
      getIpcPort: mock(() => 12345),
      getIpcSecret: mock(() => "test-secret"),
    } as unknown as Partial<ACPClient>)

    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })
    const priv = model as any

    // Write an invalid file initially
    writeFileSync(toolsFile, JSON.stringify({ tools: [], cwd: "/tmp/project" }))

    // Override writeToolsToFile to always write an incomplete file (simulating permanent failure)
    const originalWriteToolsToFile = priv.writeToolsToFile.bind(priv)
    priv.writeToolsToFile = (_path: string, _tools: any) => {
      // Write a file that still fails validation (missing tools)
      writeFileSync(toolsFile, JSON.stringify({
        tools: [],
        cwd: "/tmp/project",
        ipcPort: 12345,
        ipcSecret: "test-secret",
      }))
      return ""
    }

    // Act & Assert
    expect(() => {
      priv.ensureToolsFileReady(toolsFile, sampleTools)
    }).toThrow(KiroACPError)

    try {
      priv.ensureToolsFileReady(toolsFile, sampleTools)
    } catch (err) {
      expect(err).toBeInstanceOf(KiroACPError)
      expect((err as KiroACPError).message).toContain("Tools file is not ready for MCP bridge")
    }

    // Restore
    priv.writeToolsToFile = originalWriteToolsToFile
  })

  test("handles unreadable tools file", () => {
    // Arrange: point to a non-existent file
    const dir = makeTempDir()
    const toolsFile = join(dir, "nonexistent-tools.json")

    const client = createMockClient({
      createSessionToolsFilePath: mock(() => toolsFile),
      getCwd: mock(() => "/tmp/project"),
      getIpcPort: mock(() => 12345),
      getIpcSecret: mock(() => "test-secret"),
    } as unknown as Partial<ACPClient>)

    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })
    const priv = model as any

    // Act: ensureToolsFileReady should detect unreadable file, repair by writing, then pass
    priv.ensureToolsFileReady(toolsFile, sampleTools)

    // Assert: file should now exist with correct content
    const raw = readFileSync(toolsFile, "utf-8")
    const parsed = JSON.parse(raw)
    expect(parsed.tools).toHaveLength(2)
    expect(parsed.ipcPort).toBe(12345)
    expect(parsed.ipcSecret).toBe("test-secret")
  })
})
