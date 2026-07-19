import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test"
import { KiroACPLanguageModel, type KiroACPModelConfig } from "../src/kiro-acp-model"
import { resetAuthCache } from "../src/kiro-auth"
import { KiroACPError, KiroACPConnectionError } from "../src/acp-client"
import type { ACPClient, ACPSession, SessionUpdate, PromptOptions } from "../src/acp-client"
import type { IPCServer, PendingToolCall, ToolResultRequest } from "../src/ipc-server"
import { LaneRouter } from "../src/lane-router"
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV3Prompt,
  LanguageModelV3FunctionTool,
} from "@ai-sdk/provider"
import { readFileSync, mkdirSync, mkdtempSync, existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import * as childProcess from "node:child_process"
import { persistSession } from "../src/session-storage"

// `extractErrorMessage` corroborates -32603 via `verifyAuth()`, which spawns
// `kiro-cli`. Mock execFileSync so the auth probe is deterministic (no real
// kiro-cli spawn): `whoami --format json` returns the chosen fixture and
// `--version` succeeds so kiro-cli reads as installed. Returns the spy.
const WHOAMI_LOGGED_IN_LINE =
  '{"accountType":"IamIdentityCenter","email":"user@example.com","region":"eu-west-1","startUrl":"https://d-0000000000.awsapps.com/start"}'
function mockWhoami(whoami: string) {
  const impl = (_file: string, args?: readonly string[]) => {
    const argv = args ?? []
    if (argv.includes("--version")) return "kiro-cli 2.7.1"
    if (argv.includes("whoami")) return whoami
    return ""
  }
  return spyOn(childProcess, "execFileSync").mockImplementation(
    impl as unknown as typeof childProcess.execFileSync,
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal mock IPC server. */
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

/** Create a minimal mock ACPClient. */
function createMockClient(overrides: Partial<ACPClient> = {}): ACPClient {
  const mockLaneRouter = new LaneRouter()
  // Real promise-chain mutex (mirrors ACPClient.withEnsureClientLock) so that
  // ensureClient() serializes concurrent callers in tests just like production.
  let ensureClientLock: Promise<void> = Promise.resolve()
  let sessionSetupLock: Promise<void> = Promise.resolve()
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
    withSessionSetupLock: mock(async <T,>(fn: () => Promise<T>): Promise<T> => {
      const previousLock = sessionSetupLock
      let releaseLock!: () => void
      sessionSetupLock = new Promise<void>((resolve) => {
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
    prompt: mock(() => Promise.resolve({ stopReason: "end_turn" })),
    setModel: mock(() => Promise.resolve()),
    setMode: mock(() => Promise.resolve()),
    executeCommand: mock(() =>
      Promise.resolve({ success: true, message: "ok" }),
    ),
    getMetadata: mock(() => undefined),
    getStderr: mock(() => ""),
    getToolsRevision: mock(() => 0),
    getToolsFilePath: mock(() => null),
    getCwd: mock(() => "/tmp/test"),
    getAgentName: mock(() => undefined),
    getIpcPort: mock(() => null),
    getIpcSecret: mock(() => null),
    getIPCServer: mock(() => createMockIPCServer()),
    getLaneRouter: mock(() => mockLaneRouter),
    setPromptCallback: mock(() => {}),
    waitForToolsReady: mock((options?: { expectedTools?: string[] }) =>
      Promise.resolve(
        (options?.expectedTools ?? []).map((name) => ({ name, source: "mcp:test" })),
      ),
    ),
    getOrCreateToolsFilePath: mock(() => "/tmp/tools.json"),
    createSessionToolsFilePath: mock((id: string) => `/tmp/kiro-acp/tools-test-${id}.json`),
    removeSessionToolsFile: mock(() => {}),
    ...overrides,
  } as unknown as ACPClient
}

/** Build a minimal LanguageModelV3CallOptions with a simple user prompt. */
function makeCallOptions(
  prompt: LanguageModelV3Prompt,
  overrides: Partial<LanguageModelV3CallOptions> = {},
): LanguageModelV3CallOptions {
  return {
    prompt,
    ...overrides,
  } as LanguageModelV3CallOptions
}

/** Collect all parts from a ReadableStream. */
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

/** Create a unique temp directory for test tools files. */
function createTempToolsDir(): string {
  return mkdtempSync(join(tmpdir(), "kiro-acp-test-"))
}

async function withTempXdgDataHome<T>(
  run: (storageDir: string) => Promise<T>,
): Promise<T> {
  const storageDir = createTempToolsDir()
  const previousXdgDataHome = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = storageDir

  try {
    return await run(storageDir)
  } finally {
    if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousXdgDataHome
    rmSync(storageDir, { recursive: true, force: true })
  }
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return
    await Promise.resolve()
  }
  throw new Error("Condition was not reached within 100 microtasks")
}

function makeTool(
  name: string,
  inputSchema: LanguageModelV3FunctionTool["inputSchema"],
  description = `Tool ${name}`,
): LanguageModelV3FunctionTool {
  return { type: "function", name, description, inputSchema }
}

function createAffinityToolsetHarness(storageDir: string) {
  const cwd = join(storageDir, "project")
  mkdirSync(cwd, { recursive: true })

  let nextSession = 0
  const createSessionWithToolsPath = mock(async () => {
    nextSession++
    return {
      sessionId: `sess-${nextSession}`,
      modes: { currentModeId: "test-agent", availableModes: [] },
      models: { currentModelId: "claude-sonnet-4.6", availableModels: [] },
    } satisfies ACPSession
  })
  const loadSession = mock(async (sessionId: string) => ({
    sessionId,
    modes: { currentModeId: "test-agent", availableModes: [] },
    models: { currentModelId: "claude-sonnet-4.6", availableModels: [] },
  } satisfies ACPSession))
  const client = createMockClient({
    getCwd: mock(() => cwd),
    getAgentName: mock(() => "test-agent"),
    createSessionToolsFilePath: mock((id: string) => join(storageDir, `tools-${id}.json`)),
    createSessionWithToolsPath,
    loadSession,
    prompt: mock(async (opts: PromptOptions) => {
      opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "ready" } })
      return { stopReason: "end_turn" }
    }),
  } as unknown as Partial<ACPClient>)
  const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

  const runTurn = async (
    tools: LanguageModelV3FunctionTool[],
    affinityId = "affinity-tools",
  ): Promise<void> => {
    const result = await model.doStream(makeCallOptions(
      [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      { tools, headers: { "x-session-affinity": affinityId } },
    ))
    await collectStream(result.stream)
  }

  return { cwd, createSessionWithToolsPath, loadSession, runTurn }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KiroACPLanguageModel", () => {
  describe("metadata", () => {
    test("has correct specificationVersion, provider, and modelId", () => {
      const client = createMockClient()
      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      expect(model.specificationVersion).toBe("v3")
      expect(model.provider).toBe("kiro-acp")
      expect(model.modelId).toBe("claude-sonnet-4.6")
      expect(model.defaultObjectGenerationMode).toBeUndefined()
    })
  })

  describe("session lifecycle", () => {
    test("creates session lazily on first doStream call", async () => {
      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "hi" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      expect(client.start).not.toHaveBeenCalled()
      expect(client.createSession).not.toHaveBeenCalled()

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
      )
      await collectStream(result.stream)

      expect(client.start).toHaveBeenCalledTimes(1)
      expect(client.createSession).toHaveBeenCalledTimes(1)
    })

    test("creates a new session for each doStream call (no reuse)", async () => {
      let running = false
      const client = createMockClient({
        isRunning: mock(() => running),
        start: mock(async () => {
          running = true
          return {
            agentInfo: { name: "kiro-cli", version: "1.0.0" },
            agentCapabilities: {},
          }
        }),
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      // First call
      const r1 = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "first" }] }]),
      )
      await collectStream(r1.stream)

      // Second call
      const r2 = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "second" }] }]),
      )
      await collectStream(r2.stream)

      // Each doStream should create its own session — no reuse
      expect(client.createSession).toHaveBeenCalledTimes(2)
      expect(client.start).toHaveBeenCalledTimes(1)
    })

    test("does not call start() if client is already running", async () => {
      const client = createMockClient({
        isRunning: mock(() => true),
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "hi" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
      )
      await collectStream(result.stream)

      expect(client.start).not.toHaveBeenCalled()
      expect(client.createSession).toHaveBeenCalledTimes(1)
    })
  })

  describe("model switching", () => {
    test("calls setModel when modelId differs from session default", async () => {
      const client = createMockClient({
        createSession: mock(() =>
          Promise.resolve({
            sessionId: "sess-1",
            modes: { currentModeId: "agent", availableModes: [] },
            models: { currentModelId: "claude-sonnet-4.6", availableModels: [] },
          } satisfies ACPSession),
        ),
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "opus response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-opus-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
      )
      await collectStream(result.stream)

      expect(client.setModel).toHaveBeenCalledWith("sess-1", "claude-opus-4.6")
    })

    test("does not call setModel when modelId matches session default", async () => {
      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
      )
      await collectStream(result.stream)

      expect(client.setModel).not.toHaveBeenCalled()
    })
  })

  describe("reasoning effort (providerOptions)", () => {
    // A prompt that streams one chunk and ends cleanly, so the no-op tests can
    // assert the turn still succeeds regardless of effort handling.
    const completingPrompt = () =>
      mock(async (opts: PromptOptions) => {
        opts.onUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { text: "ok" },
        })
        return { stopReason: "end_turn" }
      })

    const effortRequest = (level: string): LanguageModelV3CallOptions =>
      makeCallOptions(
        [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        { providerOptions: { kiro: { reasoningEffort: level } } },
      )

    test("applies requested effort for supported model/level", async () => {
      const setEffort = mock(async () => ({ success: true, message: "ok" }))
      const client = createMockClient({
        setEffort,
        prompt: completingPrompt(),
      } as unknown as Partial<ACPClient>)

      // opus-4.8 supports "high"; the native level relays through unchanged.
      const model = new KiroACPLanguageModel("claude-opus-4.8", { client })

      const result = await model.doStream(effortRequest("high"))
      await collectStream(result.stream)

      expect(setEffort).toHaveBeenCalledTimes(1)
      expect(setEffort).toHaveBeenCalledWith("sess-1", "high")
    })

    test("per-request effort overrides resolved default", async () => {
      const setEffort = mock(async () => ({ success: true, message: "ok" }))
      const client = createMockClient({
        setEffort,
        prompt: completingPrompt(),
      } as unknown as Partial<ACPClient>)

      // Per-call effort must win over the resolved config.effort default.
      const model = new KiroACPLanguageModel("claude-opus-4.8", {
        client,
        effort: "low",
      })

      const result = await model.doStream(effortRequest("high"))
      await collectStream(result.stream)

      expect(setEffort).toHaveBeenCalledTimes(1)
      expect(setEffort).toHaveBeenCalledWith("sess-1", "high")
    })

    test("skips setEffort for unsupported model", async () => {
      const setEffort = mock(async () => ({ success: true, message: "ok" }))
      const client = createMockClient({
        setEffort,
        prompt: completingPrompt(),
      } as unknown as Partial<ACPClient>)

      // opus-4.5 has no effort control, so the requested level is a silent no-op.
      const model = new KiroACPLanguageModel("claude-opus-4.5", { client })

      const result = await model.doStream(effortRequest("high"))
      const parts = await collectStream(result.stream)

      expect(setEffort).not.toHaveBeenCalled()
      // The prompt still succeeds with its normal stop reason.
      const finish = parts.find((p) => p.type === "finish")
      expect(finish?.type === "finish" && finish.finishReason.unified).toBe("stop")
      expect(parts.find((p) => p.type === "error")).toBeUndefined()
    })

    test("skips setEffort for unsupported level", async () => {
      const setEffort = mock(async () => ({ success: true, message: "ok" }))
      const client = createMockClient({
        setEffort,
        prompt: completingPrompt(),
      } as unknown as Partial<ACPClient>)

      // opus-4.6 tops out at "max"; "xhigh" is out of its supported set.
      const model = new KiroACPLanguageModel("claude-opus-4.6", { client })

      const result = await model.doStream(effortRequest("xhigh"))
      const parts = await collectStream(result.stream)

      expect(setEffort).not.toHaveBeenCalled()
      const finish = parts.find((p) => p.type === "finish")
      expect(finish?.type === "finish" && finish.finishReason.unified).toBe("stop")
      expect(parts.find((p) => p.type === "error")).toBeUndefined()
    })

    test("does not throw when setEffort returns success false", async () => {
      const setEffort = mock(async () => ({
        success: false,
        message: "unsupported",
      }))
      const client = createMockClient({
        setEffort,
        prompt: completingPrompt(),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-opus-4.8", { client })

      const result = await model.doStream(effortRequest("high"))
      const parts = await collectStream(result.stream)

      // setEffort was attempted, but a false result must not break the turn.
      expect(setEffort).toHaveBeenCalledTimes(1)
      const finish = parts.find((p) => p.type === "finish")
      expect(finish?.type === "finish" && finish.finishReason.unified).toBe("stop")
      expect(parts.find((p) => p.type === "error")).toBeUndefined()
    })

    test("skips redundant setEffort when currentEffort matches", async () => {
      const setEffort = mock(async () => ({ success: true, message: "ok" }))
      const client = createMockClient({
        setEffort,
        prompt: completingPrompt(),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-opus-4.8", { client })

      // Same level across two turns: the currentEffort guard suppresses the 2nd call.
      await collectStream((await model.doStream(effortRequest("high"))).stream)
      await collectStream((await model.doStream(effortRequest("high"))).stream)

      expect(setEffort).toHaveBeenCalledTimes(1)
    })

    test("does not throw when setEffort rejects (swallows the rejection)", async () => {
      const setEffort = mock(async () => {
        throw new Error("setEffort transport failure")
      })
      const client = createMockClient({
        setEffort,
        prompt: completingPrompt(),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-opus-4.8", { client })

      const result = await model.doStream(effortRequest("high"))
      const parts = await collectStream(result.stream)

      // A rejected setEffort (vs the success:false case) must also be swallowed:
      // the turn finishes normally and no error part leaks into the stream.
      expect(setEffort).toHaveBeenCalledTimes(1)
      const finish = parts.find((p) => p.type === "finish")
      expect(finish?.type === "finish" && finish.finishReason.unified).toBe("stop")
      expect(parts.find((p) => p.type === "error")).toBeUndefined()
    })

    test("resets to the model's native default effort when a later turn is unset (non-sticky)", async () => {
      const setEffort = mock(async () => ({ success: true, message: "ok" }))
      const client = createMockClient({
        setEffort,
        prompt: completingPrompt(),
      } as unknown as Partial<ACPClient>)

      // opus-4.8's native default effort is "high".
      const model = new KiroACPLanguageModel("claude-opus-4.8", { client })

      // Turn 1: explicit per-request "max" is applied to the session.
      await collectStream((await model.doStream(effortRequest("max"))).stream)
      expect(setEffort).toHaveBeenNthCalledWith(1, "sess-1", "max")

      // Turn 2: same session, no per-request effort and no config.effort, must
      // reset to the native default ("high") rather than staying stuck at "max".
      await collectStream(
        (await model.doStream(
          makeCallOptions([{ role: "user", content: [{ type: "text", text: "hi" }] }]),
        )).stream,
      )
      expect(setEffort).toHaveBeenNthCalledWith(2, "sess-1", "high")
      expect(setEffort).toHaveBeenCalledTimes(2)
    })
  })

  describe("mode switching — waitForToolsReady", () => {
    test("calls waitForToolsReady after setMode when mode differs", async () => {
      const client = createMockClient({
        getAgentName: mock(() => "test-agent"),
        createSession: mock(() =>
          Promise.resolve({
            sessionId: "sess-1",
            modes: { currentModeId: "kiro_default", availableModes: [] },
            models: { currentModelId: "claude-sonnet-4.6", availableModels: [] },
          } satisfies ACPSession),
        ),
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
      )
      await collectStream(result.stream)

      expect(client.setMode).toHaveBeenCalledWith("sess-1", "test-agent")
      expect(client.waitForToolsReady).toHaveBeenCalledWith({ timeoutMs: 5000 })
    })

    test("skips setMode when mode already matches", async () => {
      const client = createMockClient({
        getAgentName: mock(() => "test-agent"),
        createSession: mock(() =>
          Promise.resolve({
            sessionId: "sess-1",
            modes: { currentModeId: "test-agent", availableModes: [] },
            models: { currentModelId: "claude-sonnet-4.6", availableModels: [] },
          } satisfies ACPSession),
        ),
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
      )
      await collectStream(result.stream)

      // Mode already matches from session creation — ensureSessionMode skips
      expect(client.setMode).not.toHaveBeenCalled()
      expect(client.waitForToolsReady).not.toHaveBeenCalled()
    })

    test("verifies the exact function tools after session creation", async () => {
      const toolsDir = createTempToolsDir()
      const client = createMockClient({
        getAgentName: mock(() => "test-agent"),
        getToolsRevision: mock(() => 4),
        createSessionToolsFilePath: mock((id: string) => join(toolsDir, `tools-${id}.json`)),
        createSessionWithToolsPath: mock(() =>
          Promise.resolve({
            sessionId: "sess-tools",
            modes: { currentModeId: "test-agent", availableModes: [] },
            models: { currentModelId: "claude-sonnet-4.6", availableModels: [] },
          } satisfies ACPSession),
        ),
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "ready" } })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)
      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })
      const tools: LanguageModelV3FunctionTool[] = [{
        type: "function",
        name: "agent-teams_task_complete",
        description: "Complete a task",
        inputSchema: { type: "object", properties: {} },
      }]

      await collectStream((await model.doStream(makeCallOptions(
        [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        { tools },
      ))).stream)

      expect(client.waitForToolsReady).toHaveBeenCalledWith({
        timeoutMs: 5000,
        expectedTools: ["agent-teams_task_complete"],
        afterRevision: 4,
      })
    })

    test("fails instead of silently running when Kiro never exposes expected tools", async () => {
      const toolsDir = createTempToolsDir()
      const client = createMockClient({
        getAgentName: mock(() => "test-agent"),
        getToolsRevision: mock(() => 2),
        waitForToolsReady: mock(() => Promise.resolve([])),
        createSessionToolsFilePath: mock((id: string) => join(toolsDir, `tools-${id}.json`)),
        createSessionWithToolsPath: mock(() =>
          Promise.resolve({
            sessionId: "sess-missing-tools",
            modes: { currentModeId: "test-agent", availableModes: [] },
            models: { currentModelId: "claude-sonnet-4.6", availableModels: [] },
          } satisfies ACPSession),
        ),
      } as unknown as Partial<ACPClient>)
      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })
      const tools: LanguageModelV3FunctionTool[] = [{
        type: "function",
        name: "agent-teams_task_complete",
        description: "Complete a task",
        inputSchema: { type: "object", properties: {} },
      }]

      await expect(model.doStream(makeCallOptions(
        [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        { tools },
      ))).rejects.toThrow("Kiro session did not expose the expected MCP tools")

      expect(client.setMode).toHaveBeenCalledWith("sess-missing-tools", "test-agent")
      expect(client.waitForToolsReady).toHaveBeenCalledTimes(2)
    })

    test("changed tool names recreate the persisted affinity session", async () => {
      await withTempXdgDataHome(async (storageDir) => {
        const harness = createAffinityToolsetHarness(storageDir)

        await harness.runTurn([
          makeTool("task_get", { type: "object", properties: {} }),
        ])
        await harness.runTurn([
          makeTool("task_complete", { type: "object", properties: {} }),
        ])

        expect(harness.createSessionWithToolsPath).toHaveBeenCalledTimes(2)
        expect(harness.loadSession).not.toHaveBeenCalled()
      })
    })

    test("changed schema with the same tool name recreates the persisted session", async () => {
      await withTempXdgDataHome(async (storageDir) => {
        const harness = createAffinityToolsetHarness(storageDir)

        await harness.runTurn([
          makeTool("task_complete", {
            type: "object",
            properties: { taskId: { type: "string" } },
            required: ["taskId"],
          }),
        ])
        await harness.runTurn([
          makeTool("task_complete", {
            type: "object",
            properties: {
              taskId: { type: "string" },
              summary: { type: "string" },
            },
            required: ["taskId", "summary"],
          }),
        ])

        expect(harness.createSessionWithToolsPath).toHaveBeenCalledTimes(2)
        expect(harness.loadSession).not.toHaveBeenCalled()
      })
    })

    test("canonical unchanged definitions reuse the persisted session", async () => {
      await withTempXdgDataHome(async (storageDir) => {
        const harness = createAffinityToolsetHarness(storageDir)
        const firstTools = [
          makeTool("task_complete", {
            type: "object",
            properties: {
              taskId: { type: "string", description: undefined },
              result: {
                type: "object",
                properties: {
                  summary: { type: "string" },
                  status: { type: "string" },
                },
              },
            },
            required: ["taskId"],
          } as LanguageModelV3FunctionTool["inputSchema"]),
          makeTool("task_get", {
            type: "object",
            properties: { taskId: { type: "string" } },
          }),
        ]
        const reorderedEquivalentTools = [
          makeTool("task_get", {
            properties: { taskId: { type: "string" } },
            type: "object",
          }),
          makeTool("task_complete", {
            required: ["taskId"],
            properties: {
              result: {
                properties: {
                  status: { type: "string" },
                  summary: { type: "string" },
                },
                type: "object",
              },
              taskId: { type: "string" },
            },
            type: "object",
          }),
        ]

        await harness.runTurn(firstTools)
        await harness.runTurn(reorderedEquivalentTools)

        expect(harness.createSessionWithToolsPath).toHaveBeenCalledTimes(1)
        expect(harness.loadSession).toHaveBeenCalledTimes(1)
        expect(harness.loadSession).toHaveBeenCalledWith("sess-1")
      })
    })

    test("legacy persisted session without a fingerprint is invalidated", async () => {
      await withTempXdgDataHome(async (storageDir) => {
        const harness = createAffinityToolsetHarness(storageDir)
        persistSession(harness.cwd, "sess-legacy", "affinity-tools")

        await harness.runTurn([
          makeTool("task_complete", { type: "object", properties: {} }),
        ])

        expect(harness.loadSession).not.toHaveBeenCalled()
        expect(harness.createSessionWithToolsPath).toHaveBeenCalledTimes(1)
      })
    })
  })

  describe("doStream() — text response", () => {
    test("emits stream-start, text-start, text-delta, text-end, finish", async () => {
      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "Hello " },
          })
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "world!" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "greet me" }] }]),
      )

      const parts = await collectStream(result.stream)

      // Verify stream structure
      expect(parts[0]).toEqual({ type: "stream-start", warnings: [] })
      expect(parts[1]).toEqual({ type: "text-start", id: "txt-0" })
      expect(parts[2]).toEqual({ type: "text-delta", id: "txt-0", delta: "Hello " })
      expect(parts[3]).toEqual({ type: "text-delta", id: "txt-0", delta: "world!" })
      expect(parts[4]).toEqual({ type: "text-end", id: "txt-0" })

      // Finish part
      const finish = parts[5]
      expect(finish).toBeDefined()
      expect(finish.type).toBe("finish")
      if (finish.type === "finish") {
        expect(finish.finishReason.unified).toBe("stop")
        expect(finish.finishReason.raw).toBe("end_turn")
        // Output tokens estimated from streamed text: "Hello world!" = 12 chars ≈ 3 tokens
        expect(finish.usage.outputTokens.total).toBe(Math.round(12 / 4))
        // No metadata → input tokens undefined
        expect(finish.usage.inputTokens.total).toBeUndefined()
      }
    })

    test("includes request body in result", async () => {
      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "hi" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
      )
      await collectStream(result.stream)

      expect(result.request?.body).toBe("hello")
    })
  })

  describe("doStream() — system prompt injection", () => {
    test("wraps system messages in <system_instructions> tags", async () => {
      let capturedPrompt: unknown[] = []

      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          capturedPrompt = opts.prompt
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      await model.doStream(
        makeCallOptions([
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: [{ type: "text", text: "hello" }] },
        ]),
      )

      expect(capturedPrompt).toHaveLength(1)
      const block = capturedPrompt[0] as { text: string }
      expect(block.text).toContain("<system_instructions>")
      expect(block.text).toContain("You are a helpful assistant.")
      expect(block.text).toContain("</system_instructions>")
      expect(block.text).toContain("hello")
    })

    test("sends plain user message when no system prompt", async () => {
      let capturedPrompt: unknown[] = []

      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          capturedPrompt = opts.prompt
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      await model.doStream(
        makeCallOptions([
          { role: "user", content: [{ type: "text", text: "just a question" }] },
        ]),
      )

      const textContent = (capturedPrompt[0] as { text: string }).text
      expect(textContent).not.toContain("<system_instructions>")
      expect(textContent).toBe("just a question")
    })
  })

  describe("doStream() — tool calls via IPC", () => {
    test("emits tool-call parts when IPC notifies of a tool call", async () => {
      // Create a shared lane router that the adapter will use
      const laneRouter = new LaneRouter()

      const client = createMockClient({
        getLaneRouter: mock(() => laneRouter),
        prompt: mock(async (opts: PromptOptions) => {
          // Simulate kiro emitting some text, then a tool call arrives via IPC
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "Let me check..." },
          })

          // Simulate the IPC tool call notification (happens when MCP bridge
          // sends POST /tool/pending to the IPC server)
          // The adapter registers a lane, so we route through the lane router
          laneRouter.route({
            callId: "tc-1",
            toolName: "bash",
            args: { command: "echo hello" },
          })

          // The prompt stays pending (kiro is blocked on MCP bridge)
          await new Promise((r) => setTimeout(r, 200))
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "run echo" }] }]),
      )

      const parts = await collectStream(result.stream)
      const types = parts.map((p) => p.type)

      // Should have text before tool call
      expect(types).toContain("text-start")
      expect(types).toContain("text-delta")
      expect(types).toContain("text-end")

      // Should have tool-call parts (no providerExecuted flag)
      expect(types).toContain("tool-input-start")
      expect(types).toContain("tool-input-delta")
      expect(types).toContain("tool-input-end")
      expect(types).toContain("tool-call")

      // Should NOT have tool-result (harness provides results)
      expect(types).not.toContain("tool-result")

      // Verify tool-call
      const toolCall = parts.find((p) => p.type === "tool-call")!
      expect(toolCall).toMatchObject({
        type: "tool-call",
        toolCallId: "tc-1",
        toolName: "bash",
        input: JSON.stringify({ command: "echo hello" }),
      })
      // No providerExecuted flag
      expect((toolCall as any).providerExecuted).toBeUndefined()

      // Finish reason should be tool-calls
      const finish = parts.find((p) => p.type === "finish")!
      if (finish.type === "finish") {
        expect(finish.finishReason.unified).toBe("tool-calls")
      }
    })

    test("emits tool-call without prior text when model immediately calls a tool", async () => {
      const laneRouter = new LaneRouter()

      const client = createMockClient({
        getLaneRouter: mock(() => laneRouter),
        prompt: mock(async () => {
          // Tool call immediately, no text
          laneRouter.route({
            callId: "tc-2",
            toolName: "read_file",
            args: { filePath: "/tmp/test.txt" },
          })
          await new Promise((r) => setTimeout(r, 200))
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "read file" }] }]),
      )

      const parts = await collectStream(result.stream)
      const types = parts.map((p) => p.type)

      // Should have tool-call but no text
      expect(types).toContain("tool-call")
      expect(types).not.toContain("text-delta")
      expect(types).toContain("finish")
    })
  })

  describe("doStream() — reasoning", () => {
    test("emits reasoning-start, reasoning-delta, reasoning-end for thought chunks", async () => {
      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_thought_chunk",
            content: { text: "Let me think..." },
          })
          opts.onUpdate({
            sessionUpdate: "agent_thought_chunk",
            content: { text: " about this." },
          })
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "Here's my answer." },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "think hard" }] }]),
      )

      const parts = await collectStream(result.stream)
      const types = parts.map((p) => p.type)

      expect(types).toContain("reasoning-start")
      expect(types).toContain("reasoning-delta")
      expect(types).toContain("reasoning-end")

      // Reasoning should come before text
      const reasoningStartIdx = types.indexOf("reasoning-start")
      const textStartIdx = types.indexOf("text-start")
      expect(reasoningStartIdx).toBeLessThan(textStartIdx)
    })
  })

  describe("doStream() — error handling", () => {
    // verifyAuth() memoizes for a short TTL, so without a reset one case's
    // AuthStatus would leak into the next. Drop the cache before each case.
    beforeEach(resetAuthCache)

    test("preserves original error message for non-KiroACPError errors", async () => {
      const client = createMockClient({
        prompt: mock(async () => {
          throw new Error("Connection lost")
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
      )

      const parts = await collectStream(result.stream)
      const errorPart = parts.find((p) => p.type === "error")

      expect(errorPart).toBeDefined()
      if (errorPart?.type === "error") {
        expect((errorPart.error as Error).message).toBe("Connection lost")
      }
    })

    test("passes through KiroACPError message", async () => {
      const client = createMockClient({
        prompt: mock(async () => {
          throw new KiroACPError("Session not found", -32000)
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
      )

      const parts = await collectStream(result.stream)
      const errorPart = parts.find((p) => p.type === "error")

      expect(errorPart).toBeDefined()
      if (errorPart?.type === "error") {
        expect((errorPart.error as Error).message).toBe("Session not found")
      }
    })

    test("passes through KiroACPError message directly (no keyword rewriting)", async () => {
      const client = createMockClient({
        prompt: mock(async () => {
          throw new KiroACPError("request failed", 401)
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
      )

      const parts = await collectStream(result.stream)
      const errorPart = parts.find((p) => p.type === "error")

      expect(errorPart).toBeDefined()
      if (errorPart?.type === "error") {
        expect((errorPart.error as Error).message).toBe("request failed")
      }
    })

    test("passes through KiroACPError auth timeout message from acp-client", async () => {
      const client = createMockClient({
        prompt: mock(async () => {
          throw new KiroACPError("Not logged in. Run 'kiro-cli login' to authenticate.")
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
      )

      const parts = await collectStream(result.stream)
      const errorPart = parts.find((p) => p.type === "error")

      expect(errorPart).toBeDefined()
      if (errorPart?.type === "error") {
        expect((errorPart.error as Error).message).toContain("Not logged in")
        expect((errorPart.error as Error).message).toContain("kiro-cli login")
      }
    })

    test("maps -32603 to an actionable diagnostic ONLY when whoami is NOT logged in", async () => {
      // Corroboration: whoami reports logged out, so -32603 is treated as an
      // auth problem and the message points at the diagnostics. It must NOT
      // assert a blanket "token expired" (kiro-cli auto-re-authenticates).
      const spy = mockWhoami('{"account":null}')
      try {
        const client = createMockClient({
          prompt: mock(async () => {
            throw new KiroACPError("Internal error", -32603)
          }),
        } as unknown as Partial<ACPClient>)

        const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

        const result = await model.doStream(
          makeCallOptions([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
        )

        const parts = await collectStream(result.stream)
        const errorPart = parts.find((p) => p.type === "error")

        expect(errorPart).toBeDefined()
        if (errorPart?.type === "error") {
          const message = (errorPart.error as Error).message
          // Names the diagnostics and preserves the original detail.
          expect(message).toContain("kiro-cli whoami")
          expect(message).toContain("kiro-cli doctor")
          expect(message).toContain("Internal error")
          // Does NOT assert the old over-broad "token expired" claim.
          expect(message).not.toContain("expired")
        }
      } finally {
        spy.mockRestore()
      }
    })

    test("passes the original -32603 message through when whoami IS logged in", async () => {
      // Not corroborated: whoami is logged in, so the generic Internal error is
      // surfaced as-is rather than being misattributed to an auth problem.
      const spy = mockWhoami(WHOAMI_LOGGED_IN_LINE)
      try {
        const client = createMockClient({
          prompt: mock(async () => {
            throw new KiroACPError("Backend stream aborted", -32603)
          }),
        } as unknown as Partial<ACPClient>)

        const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

        const result = await model.doStream(
          makeCallOptions([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
        )

        const parts = await collectStream(result.stream)
        const errorPart = parts.find((p) => p.type === "error")

        expect(errorPart).toBeDefined()
        if (errorPart?.type === "error") {
          const message = (errorPart.error as Error).message
          expect(message).toBe("Backend stream aborted")
          expect(message).not.toContain("kiro-cli doctor")
        }
      } finally {
        spy.mockRestore()
      }
    })

    test("map_32603_message_no_emdash", async () => {
      // Force the corroborated (logged-out) branch so the actionable message is
      // emitted, then assert ASCII-punctuation only: no em-dash (U+2014) and no
      // en-dash (U+2013).
      const spy = mockWhoami('{"account":null}')
      try {
        const client = createMockClient({
          prompt: mock(async () => {
            throw new KiroACPError("Internal error", -32603)
          }),
        } as unknown as Partial<ACPClient>)

        const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

        const result = await model.doStream(
          makeCallOptions([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
        )

        const parts = await collectStream(result.stream)
        const errorPart = parts.find((p) => p.type === "error")

        expect(errorPart).toBeDefined()
        if (errorPart?.type === "error") {
          const message = (errorPart.error as Error).message
          expect(message).not.toContain("\u2014")
          expect(message).not.toContain("\u2013")
        }
      } finally {
        spy.mockRestore()
      }
    })

    test("does NOT rewrite non -32603 KiroACPError codes", async () => {
      const client = createMockClient({
        prompt: mock(async () => {
          throw new KiroACPError("Internal error", -32000)
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
      )

      const parts = await collectStream(result.stream)
      const errorPart = parts.find((p) => p.type === "error")

      expect(errorPart).toBeDefined()
      if (errorPart?.type === "error") {
        // Code is not -32603, so the message passes through verbatim.
        expect((errorPart.error as Error).message).toBe("Internal error")
      }
    })

    test("passes through KiroACPError service timeout message from acp-client", async () => {
      const client = createMockClient({
        prompt: mock(async () => {
          throw new KiroACPError(
            "Request timed out after 30000ms: initialize",
          )
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
      )

      const parts = await collectStream(result.stream)
      const errorPart = parts.find((p) => p.type === "error")

      expect(errorPart).toBeDefined()
      if (errorPart?.type === "error") {
        expect((errorPart.error as Error).message).toBe("Request timed out after 30000ms: initialize")
      }
    })

    test("passes through plain Error message without rewriting", async () => {
      const client = createMockClient({
        prompt: mock(async () => {
          throw new Error("Not logged in to Kiro")
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
      )

      const parts = await collectStream(result.stream)
      const errorPart = parts.find((p) => p.type === "error")

      expect(errorPart).toBeDefined()
      if (errorPart?.type === "error") {
        expect((errorPart.error as Error).message).toBe("Not logged in to Kiro")
      }
    })

    test("passes through service error message from KiroACPError without rewriting", async () => {
      const client = createMockClient({
        prompt: mock(async () => {
          throw new KiroACPError("backend error", 503)
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
      )

      const parts = await collectStream(result.stream)
      const errorPart = parts.find((p) => p.type === "error")

      expect(errorPart).toBeDefined()
      if (errorPart?.type === "error") {
        expect((errorPart.error as Error).message).toBe("backend error")
      }
    })

    test("passes through prompt timeout message from acp-client", async () => {
      const client = createMockClient({
        prompt: mock(async () => {
          throw new KiroACPError(
            "Request timed out after 300000ms: session/prompt",
          )
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
      )

      const parts = await collectStream(result.stream)
      const errorPart = parts.find((p) => p.type === "error")

      expect(errorPart).toBeDefined()
      if (errorPart?.type === "error") {
        expect((errorPart.error as Error).message).toBe("Request timed out after 300000ms: session/prompt")
      }
    })

    test("passes through KiroACPConnectionError message directly", async () => {
      const client = createMockClient({
        prompt: mock(async () => {
          throw new KiroACPConnectionError("Process exited (code=1, signal=null)")
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
      )

      const parts = await collectStream(result.stream)
      const errorPart = parts.find((p) => p.type === "error")

      expect(errorPart).toBeDefined()
      if (errorPart?.type === "error") {
        expect((errorPart.error as Error).message).toBe("Process exited (code=1, signal=null)")
      }
    })

    test("stringifies non-Error thrown values", async () => {
      const client = createMockClient({
        prompt: mock(async () => {
          throw "raw string error"
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
      )

      const parts = await collectStream(result.stream)
      const errorPart = parts.find((p) => p.type === "error")

      expect(errorPart).toBeDefined()
      if (errorPart?.type === "error") {
        expect((errorPart.error as Error).message).toBe("raw string error")
      }
    })
  })

  describe("doStream() — finish reasons", () => {
    test.each([
      ["end_turn", "stop"],
      ["max_tokens", "length"],
      ["content_filter", "content-filter"],
      ["unknown_reason", "other"],
    ] as const)("maps ACP stop reason '%s' to unified '%s'", async (acpReason, expectedUnified) => {
      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: acpReason }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
      )

      const parts = await collectStream(result.stream)
      const finish = parts.find((p) => p.type === "finish")

      expect(finish).toBeDefined()
      if (finish?.type === "finish") {
        expect(finish.finishReason.unified).toBe(expectedUnified)
        expect(finish.finishReason.raw).toBe(acpReason)
      }
    })

    test("maps ACP stop reason 'cancelled' to error part instead of finish", async () => {
      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "partial response" },
          })
          return { stopReason: "cancelled" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
      )

      const parts = await collectStream(result.stream)
      const types = parts.map((p) => p.type)

      // Should NOT have a finish part — cancellation emits error instead
      expect(types).not.toContain("finish")

      // Should have an error part
      const errorPart = parts.find((p) => p.type === "error")
      expect(errorPart).toBeDefined()
      if (errorPart?.type === "error") {
        expect((errorPart.error as Error).message).toBe("Request was cancelled by user")
      }

      // Text spans should still be properly closed
      expect(types).toContain("text-end")
    })
  })

  describe("doStream() — metadata", () => {
    test("includes kiro metadata with credits in finish part", async () => {
      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
        getMetadata: mock(() => ({
          sessionId: "sess-1",
          contextUsagePercentage: 0.035,
          turnDurationMs: 2500,
          meteringUsage: [{ unit: "credit", unitPlural: "credits", value: 0.03 }],
        })),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
      )

      const parts = await collectStream(result.stream)
      const finish = parts.find((p) => p.type === "finish")

      expect(finish).toBeDefined()
      if (finish?.type === "finish") {
        expect(finish.providerMetadata).toEqual({
          kiro: {
            contextUsagePercentage: 0.035,
            turnDurationMs: 2500,
            credits: 0.03,
            creditsUnit: "credit",
          },
        })
      }
    })

    test("sets credits to null when not available", async () => {
      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
        getMetadata: mock(() => ({
          sessionId: "sess-1",
          turnDurationMs: 3200,
        })),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
      )

      const parts = await collectStream(result.stream)
      const finish = parts.find((p) => p.type === "finish")

      expect(finish).toBeDefined()
      if (finish?.type === "finish") {
        expect(finish.providerMetadata).toEqual({
          kiro: {
            contextUsagePercentage: null,
            turnDurationMs: 3200,
            credits: null,
            creditsUnit: null,
          },
        })
      }
    })

    test("accumulates credits across multiple turns", async () => {
      let callCount = 0
      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
        getMetadata: mock(() => {
          callCount++
          return {
            sessionId: "sess-1",
            contextUsagePercentage: 0.05 * callCount,
            turnDurationMs: 1000,
            meteringUsage: [{ unit: "credit", unitPlural: "credits", value: 0.02 * callCount }],
          }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      // First turn
      const r1 = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "first" }] }]),
      )
      await collectStream(r1.stream)
      expect(model.getTotalCredits()).toBeCloseTo(0.02)

      // Second turn
      const r2 = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "second" }] }]),
      )
      await collectStream(r2.stream)
      expect(model.getTotalCredits()).toBeCloseTo(0.06) // 0.02 + 0.04
    })

    test("estimates tokens from streamed text and contextUsagePercentage", async () => {
      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "a".repeat(200) },
          })
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "b".repeat(200) },
          })
          return { stopReason: "end_turn" }
        }),
        getMetadata: mock(() => ({
          sessionId: "sess-1",
          contextUsagePercentage: 1.14,
          turnDurationMs: 2000,
          meteringUsage: [{ unit: "credit", unitPlural: "credits", value: 0.05 }],
        })),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
      )

      const parts = await collectStream(result.stream)
      const finish = parts.find((p) => p.type === "finish")

      expect(finish).toBeDefined()
      if (finish?.type === "finish") {
        expect(finish.usage.outputTokens.total).toBe(100)
        expect(finish.usage.outputTokens.text).toBe(100)
        expect(finish.usage.outputTokens.reasoning).toBeUndefined()
        expect(finish.usage.inputTokens.total).toBe(11_300)
        expect(finish.usage.inputTokens.noCache).toBe(11_300)
        expect(finish.usage.inputTokens.cacheRead).toBeUndefined()
        expect(finish.usage.inputTokens.cacheWrite).toBeUndefined()
      }
    })

    test("returns undefined input tokens when no metadata available", async () => {
      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "short reply" },
          })
          return { stopReason: "end_turn" }
        }),
        getMetadata: mock(() => undefined),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
      )

      const parts = await collectStream(result.stream)
      const finish = parts.find((p) => p.type === "finish")

      expect(finish).toBeDefined()
      if (finish?.type === "finish") {
        expect(finish.usage.outputTokens.total).toBe(Math.round(11 / 4))
        expect(finish.usage.inputTokens.total).toBeUndefined()
      }
    })

    test("returns undefined output tokens when no text was streamed", async () => {
      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          // No text output at all — just completes
          return { stopReason: "end_turn" }
        }),
        getMetadata: mock(() => ({
          sessionId: "sess-1",
          contextUsagePercentage: 0.05,
          turnDurationMs: 500,
        })),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
      )

      const parts = await collectStream(result.stream)
      const finish = parts.find((p) => p.type === "finish")

      expect(finish).toBeDefined()
      if (finish?.type === "finish") {
        expect(finish.usage.outputTokens.total).toBeUndefined()
        expect(finish.usage.outputTokens.text).toBeUndefined()
        expect(finish.usage.inputTokens.total).toBe(500)
        expect(finish.usage.inputTokens.noCache).toBe(500)
      }
    })
  })

  describe("doGenerate()", () => {
    test("consumes stream and returns complete text content", async () => {
      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "Hello " },
          })
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "world!" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doGenerate(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "greet me" }] }]),
      )

      expect(result.content).toHaveLength(1)
      expect(result.content[0]).toEqual({ type: "text", text: "Hello world!" })
      expect(result.finishReason.unified).toBe("stop")
      expect(result.warnings).toEqual([])
    })

    test("returns tool-call content blocks (no tool-result — harness provides)", async () => {
      const laneRouter = new LaneRouter()

      const client = createMockClient({
        getLaneRouter: mock(() => laneRouter),
        prompt: mock(async () => {
          laneRouter.route({
            callId: "tc-1",
            toolName: "bash",
            args: { command: "ls" },
          })
          await new Promise((r) => setTimeout(r, 200))
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doGenerate(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "list files" }] }]),
      )

      const toolCall = result.content.find((c) => c.type === "tool-call")
      expect(toolCall).toBeDefined()

      if (toolCall?.type === "tool-call") {
        expect(toolCall.toolName).toBe("bash")
        expect(toolCall.input).toBe(JSON.stringify({ command: "ls" }))
        // No providerExecuted flag
        expect((toolCall as any).providerExecuted).toBeUndefined()
      }

      // No tool-result — harness provides results
      const toolResult = result.content.find((c) => c.type === "tool-result")
      expect(toolResult).toBeUndefined()
    })

    test("returns reasoning content blocks", async () => {
      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_thought_chunk",
            content: { text: "Thinking..." },
          })
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "Answer." },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doGenerate(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "think" }] }]),
      )

      const reasoning = result.content.find((c) => c.type === "reasoning")
      const text = result.content.find((c) => c.type === "text")

      expect(reasoning).toEqual({ type: "reasoning", text: "Thinking..." })
      expect(text).toEqual({ type: "text", text: "Answer." })
    })
  })

  describe("prompt extraction", () => {
    test("sends only the last user message, skipping history and assistant messages", async () => {
      let capturedPrompt: unknown[] = []

      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          capturedPrompt = opts.prompt
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      await model.doStream(
        makeCallOptions([
          { role: "user", content: [{ type: "text", text: "first question" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: "first answer" }],
          },
          { role: "user", content: [{ type: "text", text: "follow up" }] },
        ]),
      )

      const textContent = (capturedPrompt[0] as { text: string }).text
      expect(textContent).toBe("follow up")
      expect(textContent).not.toContain("first question")
      expect(textContent).not.toContain("first answer")
    })

    test("concatenates multiple system messages", async () => {
      let capturedPrompt: unknown[] = []

      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          capturedPrompt = opts.prompt
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      await model.doStream(
        makeCallOptions([
          { role: "system", content: "Rule 1: Be helpful." },
          { role: "system", content: "Rule 2: Be concise." },
          { role: "user", content: [{ type: "text", text: "hello" }] },
        ]),
      )

      const textContent = (capturedPrompt[0] as { text: string }).text
      expect(textContent).toContain("Rule 1: Be helpful.")
      expect(textContent).toContain("Rule 2: Be concise.")
      expect(textContent).toContain("<system_instructions>")
    })

    test("skips tool messages — kiro-cli manages tool results in its session", async () => {
      let capturedPrompt: unknown[] = []

      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          capturedPrompt = opts.prompt
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      await model.doStream(
        makeCallOptions([
          { role: "user", content: [{ type: "text", text: "run a command" }] },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "tc-1",
                toolName: "bash",
                input: JSON.stringify({ command: "echo hello" }),
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "tc-1",
                toolName: "bash",
                output: { type: "text" as const, value: "hello\n" },
              },
            ],
          },
          { role: "user", content: [{ type: "text", text: "what was the output?" }] },
        ]),
      )

      const textContent = (capturedPrompt[0] as { text: string }).text
      expect(textContent).toBe("what was the output?")
      expect(textContent).not.toContain("hello\n")
      expect(textContent).not.toContain("bash")
    })
  })

  describe("writeToolsFile() — dynamic tool synchronization", () => {
    test("writes AI SDK function tools to the tools file in MCP format", async () => {
      const toolsDir = createTempToolsDir()
      const toolsFile = join(toolsDir, "tools.json")

      const client = createMockClient({
        createSessionToolsFilePath: mock(() => toolsFile),
        getCwd: mock(() => "/tmp/project"),
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "done" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "bash",
          description: "Execute a bash command",
          inputSchema: {
            type: "object",
            properties: {
              command: { type: "string", description: "The command to run" },
            },
            required: ["command"],
          },
        },
        {
          type: "function",
          name: "read",
          description: "Read a file",
          inputSchema: {
            type: "object",
            properties: {
              filePath: { type: "string", description: "Path to the file" },
            },
            required: ["filePath"],
          },
        },
      ]

      const result = await model.doStream(
        makeCallOptions(
          [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          { tools },
        ),
      )
      await collectStream(result.stream)

      expect(existsSync(toolsFile)).toBe(true)
      const written = JSON.parse(readFileSync(toolsFile, "utf-8"))

      expect(written.tools).toHaveLength(2)
      expect(written.cwd).toBe("/tmp/project")

      expect(written.tools[0]).toEqual({
        name: "bash",
        description: "Execute a bash command",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "The command to run" },
          },
          required: ["command"],
        },
      })

      expect(written.tools[1]).toEqual({
        name: "read",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Path to the file" },
          },
          required: ["filePath"],
        },
      })
    })

    test("skips provider tools and only syncs function tools", async () => {
      const toolsDir = createTempToolsDir()
      const toolsFile = join(toolsDir, "tools.json")

      const client = createMockClient({
        createSessionToolsFilePath: mock(() => toolsFile),
        getCwd: mock(() => "/tmp/project"),
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "done" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const tools = [
        {
          type: "function" as const,
          name: "bash",
          description: "Execute a bash command",
          inputSchema: {
            type: "object" as const,
            properties: {
              command: { type: "string", description: "The command" },
            },
            required: ["command"],
          },
        },
        {
          type: "provider" as const,
          id: "openai.code_interpreter" as const,
          name: "code_interpreter",
          args: {},
        },
      ]

      const result = await model.doStream(
        makeCallOptions(
          [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          { tools },
        ),
      )
      await collectStream(result.stream)

      const written = JSON.parse(readFileSync(toolsFile, "utf-8"))
      expect(written.tools).toHaveLength(1)
      expect(written.tools[0].name).toBe("bash")
    })

    test("does not write tools file when no tools are provided", async () => {
      const toolsDir = createTempToolsDir()
      const toolsFile = join(toolsDir, "tools.json")

      const client = createMockClient({
        createSessionToolsFilePath: mock(() => toolsFile),
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "done" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions(
          [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        ),
      )
      await collectStream(result.stream)

      expect(existsSync(toolsFile)).toBe(false)
    })

    test("writes tools file even before client is started (lazy start)", async () => {
      const toolsDir = createTempToolsDir()
      const toolsFile = join(toolsDir, "tools.json")

      const client = createMockClient({
        createSessionToolsFilePath: mock(() => toolsFile),
        getCwd: mock(() => "/tmp/project"),
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "done" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "bash",
          description: "Execute a bash command",
          inputSchema: {
            type: "object",
            properties: {
              command: { type: "string" },
            },
            required: ["command"],
          },
        },
      ]

      const result = await model.doStream(
        makeCallOptions(
          [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          { tools },
        ),
      )
      await collectStream(result.stream)

      // Tools should be written even though client wasn't running before doStream
      expect(existsSync(toolsFile)).toBe(true)
      const written = JSON.parse(readFileSync(toolsFile, "utf-8"))
      expect(written.tools).toHaveLength(1)
      expect(written.tools[0].name).toBe("bash")
    })

    test("uses empty string for missing tool description", async () => {
      const toolsDir = createTempToolsDir()
      const toolsFile = join(toolsDir, "tools.json")

      const client = createMockClient({
        createSessionToolsFilePath: mock(() => toolsFile),
        getCwd: mock(() => "/tmp/project"),
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "done" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "glob",
          inputSchema: {
            type: "object",
            properties: {
              pattern: { type: "string" },
            },
            required: ["pattern"],
          },
        },
      ]

      const result = await model.doStream(
        makeCallOptions(
          [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          { tools },
        ),
      )
      await collectStream(result.stream)

      const written = JSON.parse(readFileSync(toolsFile, "utf-8"))
      expect(written.tools[0].description).toBe("")
    })

    test("writes a new tools file for each doStream call (no reuse)", async () => {
      const toolsDir = createTempToolsDir()

      let callCount = 0
      const toolsFiles: string[] = []

      const client = createMockClient({
        createSessionToolsFilePath: mock((id: string) => {
          const path = join(toolsDir, `tools-${id}.json`)
          toolsFiles.push(path)
          return path
        }),
        getCwd: mock(() => "/tmp/project"),
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "done" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "bash",
          description: "Execute a bash command",
          inputSchema: {
            type: "object",
            properties: {
              command: { type: "string", description: "The command" },
            },
            required: ["command"],
          },
        },
      ]

      // First call — writes tools file
      const r1 = await model.doStream(
        makeCallOptions(
          [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          { tools },
        ),
      )
      await collectStream(r1.stream)

      // Second call with same tools — still writes a NEW tools file
      const r2 = await model.doStream(
        makeCallOptions(
          [{ role: "user", content: [{ type: "text", text: "hello again" }] }],
          { tools },
        ),
      )
      await collectStream(r2.stream)

      // Each doStream should create its own tools file (different paths)
      expect(toolsFiles).toHaveLength(2)
      expect(toolsFiles[0]).not.toBe(toolsFiles[1])
    })

    test("does not call waitForToolsReady since each doStream creates a new session", async () => {
      const toolsDir = createTempToolsDir()

      let fileCount = 0
      const client = createMockClient({
        isRunning: mock(() => true),
        createSessionToolsFilePath: mock((id: string) => join(toolsDir, `tools-${id}.json`)),
        getCwd: mock(() => "/tmp/project"),
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "done" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const tools1: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "bash",
          description: "Execute a bash command",
          inputSchema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ]

      // First call
      const r1 = await model.doStream(
        makeCallOptions(
          [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          { tools: tools1 },
        ),
      )
      await collectStream(r1.stream)

      // Second call with different tools — each gets a new session,
      // so no waitForToolsReady is needed (tools are written before session creation)
      const tools2: LanguageModelV3FunctionTool[] = [
        ...tools1,
        {
          type: "function",
          name: "read",
          description: "Read a file",
          inputSchema: {
            type: "object",
            properties: { filePath: { type: "string" } },
            required: ["filePath"],
          },
        },
      ]

      const r2 = await model.doStream(
        makeCallOptions(
          [{ role: "user", content: [{ type: "text", text: "hello again" }] }],
          { tools: tools2 },
        ),
      )
      await collectStream(r2.stream)

      // waitForToolsReady should NOT be called — each doStream creates a new
      // session with tools written before creation, so the bridge reads them on spawn
      expect(client.waitForToolsReady).not.toHaveBeenCalled()
    })

    test("does not call waitForToolsReady when tools change but client is not running", async () => {
      const toolsDir = createTempToolsDir()
      const toolsFile = join(toolsDir, "tools.json")

      const client = createMockClient({
        isRunning: mock(() => false),
        createSessionToolsFilePath: mock(() => toolsFile),
        getCwd: mock(() => "/tmp/project"),
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "done" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "bash",
          description: "Execute a bash command",
          inputSchema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ]

      const result = await model.doStream(
        makeCallOptions(
          [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          { tools },
        ),
      )
      await collectStream(result.stream)

      // Client not running → no need to wait for notification
      expect(client.waitForToolsReady).not.toHaveBeenCalled()
    })
  })

  describe("doStream() — affinity header", () => {
    test("doStream extracts x-session-affinity header", async () => {
      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      // Spy on setAffinityId
      let capturedAffinityId: string | undefined = "NOT_SET"
      const originalSetAffinityId = model.setAffinityId.bind(model)
      model.setAffinityId = (id: string | undefined) => {
        capturedAffinityId = id
        originalSetAffinityId(id)
      }

      const result = await model.doStream(
        makeCallOptions(
          [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          { headers: { "x-session-affinity": "sess-42" } },
        ),
      )
      await collectStream(result.stream)

      expect(capturedAffinityId).toBe("sess-42")
    })

    test("doStream uses undefined affinity when header missing", async () => {
      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      let capturedAffinityId: string | undefined = "NOT_SET"
      const originalSetAffinityId = model.setAffinityId.bind(model)
      model.setAffinityId = (id: string | undefined) => {
        capturedAffinityId = id
        originalSetAffinityId(id)
      }

      const result = await model.doStream(
        makeCallOptions(
          [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          { headers: {} },
        ),
      )
      await collectStream(result.stream)

      expect(capturedAffinityId).toBeUndefined()
    })

    test("doStream handles undefined headers object", async () => {
      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      let capturedAffinityId: string | undefined = "NOT_SET"
      const originalSetAffinityId = model.setAffinityId.bind(model)
      model.setAffinityId = (id: string | undefined) => {
        capturedAffinityId = id
        originalSetAffinityId(id)
      }

      const result = await model.doStream(
        makeCallOptions(
          [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          { headers: undefined },
        ),
      )
      await collectStream(result.stream)

      expect(capturedAffinityId).toBeUndefined()
    })
  })

  describe("formatConversationReplay — image placeholders", () => {
    test("includes [Image: image/png] placeholder for file parts with image MIME", async () => {
      let capturedPrompt: unknown[] = []

      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          capturedPrompt = opts.prompt
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      await model.doStream(
        makeCallOptions(
          [
            {
              role: "user",
              content: [
                {
                  type: "file",
                  data: new Uint8Array([0x89, 0x50]),
                  mediaType: "image/png",
                },
              ],
            },
            {
              role: "assistant",
              content: [{ type: "text", text: "I see an image." }],
            },
            { role: "user", content: [{ type: "text", text: "describe it" }] },
          ],
          { headers: { "x-session-reset": "true" } },
        ),
      )

      const textContent = (capturedPrompt[0] as { text: string }).text
      expect(textContent).toContain("[Image: image/png]")
      expect(textContent).toContain("describe it")
    })

    test("handles mixed text + image user messages in correct order", async () => {
      let capturedPrompt: unknown[] = []

      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          capturedPrompt = opts.prompt
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      await model.doStream(
        makeCallOptions(
          [
            {
              role: "user",
              content: [
                { type: "text", text: "Here is my screenshot:" },
                {
                  type: "file",
                  data: new Uint8Array([0x89, 0x50]),
                  mediaType: "image/png",
                },
                { type: "text", text: "What do you see?" },
              ],
            },
            {
              role: "assistant",
              content: [{ type: "text", text: "I see a screenshot." }],
            },
            { role: "user", content: [{ type: "text", text: "thanks" }] },
          ],
          { headers: { "x-session-reset": "true" } },
        ),
      )

      const textContent = (capturedPrompt[0] as { text: string }).text
      // The history should contain the mixed message with text and image placeholder
      expect(textContent).toContain("Here is my screenshot:\n[Image: image/png]\nWhat do you see?")
    })

    test("normalizes image/* wildcard to image/jpeg in placeholder", async () => {
      let capturedPrompt: unknown[] = []

      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          capturedPrompt = opts.prompt
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      await model.doStream(
        makeCallOptions(
          [
            {
              role: "user",
              content: [
                {
                  type: "file",
                  data: new Uint8Array([0xff, 0xd8]),
                  mediaType: "image/*",
                },
              ],
            },
            {
              role: "assistant",
              content: [{ type: "text", text: "Got it." }],
            },
            { role: "user", content: [{ type: "text", text: "next" }] },
          ],
          { headers: { "x-session-reset": "true" } },
        ),
      )

      const textContent = (capturedPrompt[0] as { text: string }).text
      expect(textContent).toContain("[Image: image/jpeg]")
      expect(textContent).not.toContain("image/*")
    })

    test("text-only messages are unchanged (no regression)", async () => {
      let capturedPrompt: unknown[] = []

      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          capturedPrompt = opts.prompt
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      await model.doStream(
        makeCallOptions(
          [
            { role: "user", content: [{ type: "text", text: "hello" }] },
            {
              role: "assistant",
              content: [{ type: "text", text: "hi there" }],
            },
            { role: "user", content: [{ type: "text", text: "follow up" }] },
          ],
          { headers: { "x-session-reset": "true" } },
        ),
      )

      const textContent = (capturedPrompt[0] as { text: string }).text
      expect(textContent).toContain("User: hello")
      expect(textContent).toContain("Assistant: hi there")
      expect(textContent).toContain("follow up")
      expect(textContent).not.toContain("[Image:")
    })

    test("non-image file parts get a [File: mime] placeholder", async () => {
      let capturedPrompt: unknown[] = []

      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          capturedPrompt = opts.prompt
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      await model.doStream(
        makeCallOptions(
          [
            {
              role: "user",
              content: [
                { type: "text", text: "check this file" },
                {
                  type: "file",
                  data: new Uint8Array([0x25, 0x50]),
                  mediaType: "application/pdf",
                },
              ],
            },
            {
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
            },
            { role: "user", content: [{ type: "text", text: "done" }] },
          ],
          { headers: { "x-session-reset": "true" } },
        ),
      )

      const textContent = (capturedPrompt[0] as { text: string }).text
      expect(textContent).toContain("check this file")
      expect(textContent).not.toContain("[Image:")
      expect(textContent).toContain("[File: application/pdf]")
    })
  })

  describe("extractPrompt — base64 conversion (Task 01)", () => {
    test("converts Uint8Array image data to base64", async () => {
      let capturedPrompt: unknown[] = []

      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          capturedPrompt = opts.prompt
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

      await model.doStream(
        makeCallOptions([
          {
            role: "user",
            content: [
              { type: "file", data: bytes, mediaType: "image/png" },
            ],
          },
        ]),
      )

      const imageBlock = capturedPrompt[0] as { type: string; data: string; mimeType: string }
      expect(imageBlock.type).toBe("image")
      expect(imageBlock.data).toBe(Buffer.from(bytes).toString("base64"))
      expect(imageBlock.mimeType).toBe("image/png")
    })

    test("passes string image data through unchanged", async () => {
      let capturedPrompt: unknown[] = []

      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          capturedPrompt = opts.prompt
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      await model.doStream(
        makeCallOptions([
          {
            role: "user",
            content: [
              { type: "file", data: "aGVsbG8=", mediaType: "image/jpeg" },
            ],
          },
        ]),
      )

      const imageBlock = capturedPrompt[0] as { type: string; data: string; mimeType: string }
      expect(imageBlock.type).toBe("image")
      expect(imageBlock.data).toBe("aGVsbG8=")
    })

    test("extracts base64 from data URL", async () => {
      let capturedPrompt: unknown[] = []

      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          capturedPrompt = opts.prompt
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      await model.doStream(
        makeCallOptions([
          {
            role: "user",
            content: [
              {
                type: "file",
                data: new URL("data:image/png;base64,abc123"),
                mediaType: "image/png",
              },
            ],
          },
        ]),
      )

      const imageBlock = capturedPrompt[0] as { type: string; data: string }
      expect(imageBlock.type).toBe("image")
      expect(imageBlock.data).toBe("abc123")
    })

    test("normalizes image/* wildcard to image/jpeg", async () => {
      let capturedPrompt: unknown[] = []

      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          capturedPrompt = opts.prompt
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      await model.doStream(
        makeCallOptions([
          {
            role: "user",
            content: [
              { type: "file", data: "imgdata", mediaType: "image/*" },
            ],
          },
        ]),
      )

      const imageBlock = capturedPrompt[0] as { type: string; mimeType: string }
      expect(imageBlock.type).toBe("image")
      expect(imageBlock.mimeType).toBe("image/jpeg")
    })

    test("preserves concrete image MIME types", async () => {
      let capturedPrompt: unknown[] = []

      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          capturedPrompt = opts.prompt
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      await model.doStream(
        makeCallOptions([
          {
            role: "user",
            content: [
              { type: "file", data: "webpdata", mediaType: "image/webp" },
            ],
          },
        ]),
      )

      const imageBlock = capturedPrompt[0] as { type: string; mimeType: string }
      expect(imageBlock.type).toBe("image")
      expect(imageBlock.mimeType).toBe("image/webp")
    })
  })

  describe("extractPrompt — image handling (Task 02)", () => {
    test("sends text ContentBlocks for text-only prompt", async () => {
      let capturedPrompt: unknown[] = []

      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          capturedPrompt = opts.prompt
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      await model.doStream(
        makeCallOptions([
          { role: "user", content: [{ type: "text", text: "hello world" }] },
        ]),
      )

      expect(capturedPrompt).toHaveLength(1)
      expect(capturedPrompt[0]).toEqual({ type: "text", text: "hello world" })
    })

    test("sends image ContentBlocks for file parts", async () => {
      let capturedPrompt: unknown[] = []

      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          capturedPrompt = opts.prompt
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      await model.doStream(
        makeCallOptions([
          {
            role: "user",
            content: [
              { type: "file", data: "imgdata", mediaType: "image/png" },
            ],
          },
        ]),
      )

      expect(capturedPrompt).toHaveLength(1)
      expect(capturedPrompt[0]).toEqual({
        type: "image",
        data: "imgdata",
        mimeType: "image/png",
      })
    })

    test("sends mixed text + image ContentBlocks", async () => {
      let capturedPrompt: unknown[] = []

      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          capturedPrompt = opts.prompt
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      await model.doStream(
        makeCallOptions([
          {
            role: "user",
            content: [
              { type: "text", text: "Look at this:" },
              { type: "file", data: "imgdata", mediaType: "image/png" },
              { type: "text", text: "What is it?" },
            ],
          },
        ]),
      )

      expect(capturedPrompt).toHaveLength(3)
      expect(capturedPrompt[0]).toEqual({ type: "text", text: "Look at this:" })
      expect(capturedPrompt[1]).toEqual({
        type: "image",
        data: "imgdata",
        mimeType: "image/png",
      })
      expect(capturedPrompt[2]).toEqual({ type: "text", text: "What is it?" })
    })

    test("ignores non-image file parts", async () => {
      let capturedPrompt: unknown[] = []

      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          capturedPrompt = opts.prompt
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      await model.doStream(
        makeCallOptions([
          {
            role: "user",
            content: [
              { type: "text", text: "check this" },
              { type: "file", data: "pdfdata", mediaType: "application/pdf" },
            ],
          },
        ]),
      )

      // Only the text block should be sent; PDF is silently skipped
      expect(capturedPrompt).toHaveLength(1)
      expect(capturedPrompt[0]).toEqual({ type: "text", text: "check this" })
    })

    test("preserves system prompt with images", async () => {
      let capturedPrompt: unknown[] = []

      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          capturedPrompt = opts.prompt
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      await model.doStream(
        makeCallOptions([
          { role: "system", content: "You are a vision assistant." },
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this:" },
              { type: "file", data: "imgdata", mediaType: "image/jpeg" },
            ],
          },
        ]),
      )

      // System prompt is first, then user text, then image
      expect(capturedPrompt).toHaveLength(3)
      const systemBlock = capturedPrompt[0] as { type: string; text: string }
      expect(systemBlock.type).toBe("text")
      expect(systemBlock.text).toContain("<system_instructions>")
      expect(systemBlock.text).toContain("You are a vision assistant.")
      expect(capturedPrompt[1]).toEqual({ type: "text", text: "Describe this:" })
      expect(capturedPrompt[2]).toEqual({
        type: "image",
        data: "imgdata",
        mimeType: "image/jpeg",
      })
    })
  })

  describe("startFreshPrompt — ContentBlock[] wiring (Task 04)", () => {
    test("client.prompt receives combined text block for text-only prompts", async () => {
      let capturedPrompt: unknown[] = []

      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          capturedPrompt = opts.prompt
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      await model.doStream(
        makeCallOptions([
          { role: "system", content: "Be helpful." },
          { role: "user", content: [{ type: "text", text: "hello" }] },
        ]),
      )

      // Text-only: system prompt and user text combined into single block
      expect(capturedPrompt).toHaveLength(1)
      const block = capturedPrompt[0] as { type: string; text: string }
      expect(block.type).toBe("text")
      expect(block.text).toContain("<system_instructions>")
      expect(block.text).toContain("Be helpful.")
      expect(block.text).toContain("hello")
    })

    test("client.prompt receives image blocks from user prompt", async () => {
      let capturedPrompt: unknown[] = []

      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          capturedPrompt = opts.prompt
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      await model.doStream(
        makeCallOptions([
          {
            role: "user",
            content: [
              { type: "file", data: "imgdata", mediaType: "image/png" },
            ],
          },
        ]),
      )

      expect(capturedPrompt).toHaveLength(1)
      const imageBlock = capturedPrompt[0] as { type: string; data: string; mimeType: string }
      expect(imageBlock.type).toBe("image")
      expect(imageBlock.data).toBe("imgdata")
      expect(imageBlock.mimeType).toBe("image/png")
    })

    test("request.body contains readable representation with image placeholders", async () => {
      const client = createMockClient({
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "response" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result = await model.doStream(
        makeCallOptions([
          {
            role: "user",
            content: [
              { type: "text", text: "Look at this:" },
              { type: "file", data: "imgdata", mediaType: "image/png" },
            ],
          },
        ]),
      )
      await collectStream(result.stream)

      // request.body should contain readable text with image placeholder
      expect(result.request?.body).toContain("Look at this:")
      expect(result.request?.body).toContain("[Image: image/png]")
      // Should NOT contain raw base64 data
      expect(result.request?.body).not.toContain("imgdata")
    })
  })

  describe("Tool result image extraction", () => {
    test("doStream sends text-only tool result for text output", async () => {
      const laneRouter = new LaneRouter()
      const resolvedResults: ToolResultRequest[] = []
      const mockIPC = createMockIPCServer({
        getLaneRouter: mock(() => laneRouter),
        resolveToolResult: mock((req: ToolResultRequest) => {
          resolvedResults.push(req)
        }),
      })

      let promptResolve: ((value: { stopReason: string }) => void) | null = null

      const client = createMockClient({
        getIPCServer: mock(() => mockIPC),
        getLaneRouter: mock(() => laneRouter),
        setPromptCallback: mock(() => {}),
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "Running..." },
          })
          laneRouter.route({
            callId: "tc-text-only",
            toolName: "bash",
            args: { command: "echo hello" },
          })
          return new Promise<{ stopReason: string }>((resolve) => {
            promptResolve = resolve
          })
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      // First doStream — triggers tool call
      const result1 = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "run it" }] }]),
      )
      await collectStream(result1.stream)

      // Resolve prompt after tool result
      setTimeout(() => promptResolve?.({ stopReason: "end_turn" }), 50)

      // Second doStream with text-only tool result
      const result2 = await model.doStream(
        makeCallOptions([
          { role: "user", content: [{ type: "text", text: "run it" }] },
          {
            role: "assistant",
            content: [
              { type: "tool-call", toolCallId: "tc-text-only", toolName: "bash", input: JSON.stringify({ command: "echo hello" }) },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "tc-text-only",
                toolName: "bash",
                output: { type: "text" as const, value: "hello\n" },
              },
            ],
          },
        ]),
      )
      await collectStream(result2.stream)

      expect(resolvedResults).toHaveLength(1)
      expect(resolvedResults[0].callId).toBe("tc-text-only")
      expect(resolvedResults[0].result).toBe("hello\n")
      expect((resolvedResults[0] as Record<string, unknown>).content).toBeUndefined()
    })

    test("doStream sends image content for content output with image-data via FUP", async () => {
      const laneRouter = new LaneRouter()
      const resolvedResults: ToolResultRequest[] = []
      const mockIPC = createMockIPCServer({
        getLaneRouter: mock(() => laneRouter),
        resolveToolResult: mock((req: ToolResultRequest) => {
          resolvedResults.push(req)
        }),
      })

      let promptResolve: ((value: { stopReason: string }) => void) | null = null
      let promptCallCount = 0
      const promptCalls: PromptOptions[] = []

      const client = createMockClient({
        getIPCServer: mock(() => mockIPC),
        getLaneRouter: mock(() => laneRouter),
        setPromptCallback: mock(() => {}),
        prompt: mock(async (opts: PromptOptions) => {
          promptCallCount++
          promptCalls.push(opts)
          if (promptCallCount === 1) {
            // First call: initial prompt — emit text, route tool call
            opts.onUpdate({
              sessionUpdate: "agent_message_chunk",
              content: { text: "Taking screenshot..." },
            })
            laneRouter.route({
              callId: "tc-img-data",
              toolName: "screenshot",
              args: {},
            })
            return new Promise<{ stopReason: string }>((resolve) => {
              promptResolve = resolve
            })
          }
          // Second call: FUP with images — respond immediately
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "I can see the screenshot." },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result1 = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "take screenshot" }] }]),
      )
      await collectStream(result1.stream)

      // Resolve the first prompt (text-only tool result response) before doStream resumes
      setTimeout(() => promptResolve?.({ stopReason: "end_turn" }), 50)

      const result2 = await model.doStream(
        makeCallOptions([
          { role: "user", content: [{ type: "text", text: "take screenshot" }] },
          {
            role: "assistant",
            content: [
              { type: "tool-call", toolCallId: "tc-img-data", toolName: "screenshot", input: "{}" },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "tc-img-data",
                toolName: "screenshot",
                output: {
                  type: "content" as const,
                  value: [
                    { type: "image-data" as const, data: "iVBORw0KGgo=", mediaType: "image/png" },
                  ],
                },
              },
            ],
          },
        ]),
      )
      await collectStream(result2.stream)

      // FUP path: tool result sent WITHOUT content (text-only)
      expect(resolvedResults).toHaveLength(1)
      expect((resolvedResults[0] as Record<string, unknown>).content).toBeUndefined()

      // Follow-up prompt sent with image ContentBlocks
      expect(promptCallCount).toBe(2)
      const fupPrompt = promptCalls[1].prompt
      expect(fupPrompt).toHaveLength(2)
      expect(fupPrompt[0].type).toBe("text")
      expect(fupPrompt[1]).toEqual({
        type: "image",
        data: "iVBORw0KGgo=",
        mimeType: "image/png",
      })
    })

    test("doStream sends image content for content output with image-url via FUP", async () => {
      const laneRouter = new LaneRouter()
      const resolvedResults: ToolResultRequest[] = []
      const mockIPC = createMockIPCServer({
        getLaneRouter: mock(() => laneRouter),
        resolveToolResult: mock((req: ToolResultRequest) => {
          resolvedResults.push(req)
        }),
      })

      let promptResolve: ((value: { stopReason: string }) => void) | null = null
      let promptCallCount = 0
      const promptCalls: PromptOptions[] = []

      const client = createMockClient({
        getIPCServer: mock(() => mockIPC),
        getLaneRouter: mock(() => laneRouter),
        setPromptCallback: mock(() => {}),
        prompt: mock(async (opts: PromptOptions) => {
          promptCallCount++
          promptCalls.push(opts)
          if (promptCallCount === 1) {
            opts.onUpdate({
              sessionUpdate: "agent_message_chunk",
              content: { text: "Fetching..." },
            })
            laneRouter.route({
              callId: "tc-img-url",
              toolName: "fetch_image",
              args: {},
            })
            return new Promise<{ stopReason: string }>((resolve) => {
              promptResolve = resolve
            })
          }
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "I can see the image." },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result1 = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "fetch image" }] }]),
      )
      await collectStream(result1.stream)

      setTimeout(() => promptResolve?.({ stopReason: "end_turn" }), 50)

      const result2 = await model.doStream(
        makeCallOptions([
          { role: "user", content: [{ type: "text", text: "fetch image" }] },
          {
            role: "assistant",
            content: [
              { type: "tool-call", toolCallId: "tc-img-url", toolName: "fetch_image", input: "{}" },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "tc-img-url",
                toolName: "fetch_image",
                output: {
                  type: "content" as const,
                  value: [
                    { type: "image-url" as const, url: "https://example.com/photo.jpg", mediaType: "image/jpeg" },
                  ],
                },
              },
            ],
          },
        ]),
      )
      await collectStream(result2.stream)

      // FUP path: tool result sent WITHOUT content
      expect(resolvedResults).toHaveLength(1)
      expect((resolvedResults[0] as Record<string, unknown>).content).toBeUndefined()

      // Follow-up prompt sent with image ContentBlocks
      expect(promptCallCount).toBe(2)
      const fupPrompt = promptCalls[1].prompt
      expect(fupPrompt).toHaveLength(2)
      expect(fupPrompt[0].type).toBe("text")
      expect(fupPrompt[1]).toEqual({
        type: "image",
        data: "https://example.com/photo.jpg",
        mimeType: "image/jpeg",
      })
    })

    test("doStream sends image content for file-data with image MIME via FUP", async () => {
      const laneRouter = new LaneRouter()
      const resolvedResults: ToolResultRequest[] = []
      const mockIPC = createMockIPCServer({
        getLaneRouter: mock(() => laneRouter),
        resolveToolResult: mock((req: ToolResultRequest) => {
          resolvedResults.push(req)
        }),
      })

      let promptResolve: ((value: { stopReason: string }) => void) | null = null
      let promptCallCount = 0
      const promptCalls: PromptOptions[] = []

      const client = createMockClient({
        getIPCServer: mock(() => mockIPC),
        getLaneRouter: mock(() => laneRouter),
        setPromptCallback: mock(() => {}),
        prompt: mock(async (opts: PromptOptions) => {
          promptCallCount++
          promptCalls.push(opts)
          if (promptCallCount === 1) {
            opts.onUpdate({
              sessionUpdate: "agent_message_chunk",
              content: { text: "Processing..." },
            })
            laneRouter.route({
              callId: "tc-file-data",
              toolName: "convert",
              args: {},
            })
            return new Promise<{ stopReason: string }>((resolve) => {
              promptResolve = resolve
            })
          }
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "I can see the converted image." },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result1 = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "convert" }] }]),
      )
      await collectStream(result1.stream)

      setTimeout(() => promptResolve?.({ stopReason: "end_turn" }), 50)

      const result2 = await model.doStream(
        makeCallOptions([
          { role: "user", content: [{ type: "text", text: "convert" }] },
          {
            role: "assistant",
            content: [
              { type: "tool-call", toolCallId: "tc-file-data", toolName: "convert", input: "{}" },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "tc-file-data",
                toolName: "convert",
                output: {
                  type: "content" as const,
                  value: [
                    { type: "file-data" as const, data: "webpBase64Data", mediaType: "image/webp" },
                  ],
                },
              },
            ],
          },
        ]),
      )
      await collectStream(result2.stream)

      // FUP path: tool result sent WITHOUT content
      expect(resolvedResults).toHaveLength(1)
      expect((resolvedResults[0] as Record<string, unknown>).content).toBeUndefined()

      // Follow-up prompt sent with image ContentBlocks
      expect(promptCallCount).toBe(2)
      const fupPrompt = promptCalls[1].prompt
      expect(fupPrompt).toHaveLength(2)
      expect(fupPrompt[0].type).toBe("text")
      expect(fupPrompt[1]).toEqual({
        type: "image",
        data: "webpBase64Data",
        mimeType: "image/webp",
      })
    })

    test("doStream provides text fallback in result field and sends images via FUP", async () => {
      const laneRouter = new LaneRouter()
      const resolvedResults: ToolResultRequest[] = []
      const mockIPC = createMockIPCServer({
        getLaneRouter: mock(() => laneRouter),
        resolveToolResult: mock((req: ToolResultRequest) => {
          resolvedResults.push(req)
        }),
      })

      let promptResolve: ((value: { stopReason: string }) => void) | null = null
      let promptCallCount = 0
      const promptCalls: PromptOptions[] = []

      const client = createMockClient({
        getIPCServer: mock(() => mockIPC),
        getLaneRouter: mock(() => laneRouter),
        setPromptCallback: mock(() => {}),
        prompt: mock(async (opts: PromptOptions) => {
          promptCallCount++
          promptCalls.push(opts)
          if (promptCallCount === 1) {
            opts.onUpdate({
              sessionUpdate: "agent_message_chunk",
              content: { text: "Rendering..." },
            })
            laneRouter.route({
              callId: "tc-mixed-fallback",
              toolName: "render",
              args: {},
            })
            return new Promise<{ stopReason: string }>((resolve) => {
              promptResolve = resolve
            })
          }
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "I can see the rendered output." },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result1 = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "render" }] }]),
      )
      await collectStream(result1.stream)

      setTimeout(() => promptResolve?.({ stopReason: "end_turn" }), 50)

      const result2 = await model.doStream(
        makeCallOptions([
          { role: "user", content: [{ type: "text", text: "render" }] },
          {
            role: "assistant",
            content: [
              { type: "tool-call", toolCallId: "tc-mixed-fallback", toolName: "render", input: "{}" },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "tc-mixed-fallback",
                toolName: "render",
                output: {
                  type: "content" as const,
                  value: [
                    { type: "text" as const, text: "Rendered successfully" },
                    { type: "image-data" as const, data: "pngBase64", mediaType: "image/png" },
                  ],
                },
              },
            ],
          },
        ]),
      )
      await collectStream(result2.stream)

      // FUP path: tool result sent with text fallback but WITHOUT content
      expect(resolvedResults).toHaveLength(1)
      expect(resolvedResults[0].result).toBe("Rendered successfully")
      expect((resolvedResults[0] as Record<string, unknown>).content).toBeUndefined()

      // Follow-up prompt sent with image ContentBlocks (only images, not text)
      expect(promptCallCount).toBe(2)
      const fupPrompt = promptCalls[1].prompt
      expect(fupPrompt).toHaveLength(2)
      expect(fupPrompt[0].type).toBe("text")
      expect(fupPrompt[1]).toEqual({ type: "image", data: "pngBase64", mimeType: "image/png" })
    })

    test("doStream omits content field when no images in content output", async () => {
      const laneRouter = new LaneRouter()
      const resolvedResults: ToolResultRequest[] = []
      const mockIPC = createMockIPCServer({
        getLaneRouter: mock(() => laneRouter),
        resolveToolResult: mock((req: ToolResultRequest) => {
          resolvedResults.push(req)
        }),
      })

      let promptResolve: ((value: { stopReason: string }) => void) | null = null

      const client = createMockClient({
        getIPCServer: mock(() => mockIPC),
        getLaneRouter: mock(() => laneRouter),
        setPromptCallback: mock(() => {}),
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "Running..." },
          })
          laneRouter.route({
            callId: "tc-text-content",
            toolName: "bash",
            args: {},
          })
          return new Promise<{ stopReason: string }>((resolve) => {
            promptResolve = resolve
          })
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result1 = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "run" }] }]),
      )
      await collectStream(result1.stream)

      setTimeout(() => promptResolve?.({ stopReason: "end_turn" }), 50)

      const result2 = await model.doStream(
        makeCallOptions([
          { role: "user", content: [{ type: "text", text: "run" }] },
          {
            role: "assistant",
            content: [
              { type: "tool-call", toolCallId: "tc-text-content", toolName: "bash", input: "{}" },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "tc-text-content",
                toolName: "bash",
                output: {
                  type: "content" as const,
                  value: [
                    { type: "text" as const, text: "just text output" },
                  ],
                },
              },
            ],
          },
        ]),
      )
      await collectStream(result2.stream)

      expect(resolvedResults).toHaveLength(1)
      expect(resolvedResults[0].result).toBe("just text output")
      // No content field when there are no images
      expect((resolvedResults[0] as Record<string, unknown>).content).toBeUndefined()
    })

    test("doStream normalizes image/* wildcard in tool result via FUP", async () => {
      const laneRouter = new LaneRouter()
      const resolvedResults: ToolResultRequest[] = []
      const mockIPC = createMockIPCServer({
        getLaneRouter: mock(() => laneRouter),
        resolveToolResult: mock((req: ToolResultRequest) => {
          resolvedResults.push(req)
        }),
      })

      let promptResolve: ((value: { stopReason: string }) => void) | null = null
      let promptCallCount = 0
      const promptCalls: PromptOptions[] = []

      const client = createMockClient({
        getIPCServer: mock(() => mockIPC),
        getLaneRouter: mock(() => laneRouter),
        setPromptCallback: mock(() => {}),
        prompt: mock(async (opts: PromptOptions) => {
          promptCallCount++
          promptCalls.push(opts)
          if (promptCallCount === 1) {
            opts.onUpdate({
              sessionUpdate: "agent_message_chunk",
              content: { text: "Processing..." },
            })
            laneRouter.route({
              callId: "tc-wildcard",
              toolName: "capture",
              args: {},
            })
            return new Promise<{ stopReason: string }>((resolve) => {
              promptResolve = resolve
            })
          }
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "I can see the captured image." },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const result1 = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "capture" }] }]),
      )
      await collectStream(result1.stream)

      setTimeout(() => promptResolve?.({ stopReason: "end_turn" }), 50)

      const result2 = await model.doStream(
        makeCallOptions([
          { role: "user", content: [{ type: "text", text: "capture" }] },
          {
            role: "assistant",
            content: [
              { type: "tool-call", toolCallId: "tc-wildcard", toolName: "capture", input: "{}" },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "tc-wildcard",
                toolName: "capture",
                output: {
                  type: "content" as const,
                  value: [
                    { type: "image-data" as const, data: "wildcardBase64", mediaType: "image/*" },
                  ],
                },
              },
            ],
          },
        ]),
      )
      await collectStream(result2.stream)

      // FUP path: tool result sent WITHOUT content
      expect(resolvedResults).toHaveLength(1)
      expect((resolvedResults[0] as Record<string, unknown>).content).toBeUndefined()

      // Follow-up prompt sent with normalized mimeType
      expect(promptCallCount).toBe(2)
      const fupPrompt = promptCalls[1].prompt
      expect(fupPrompt).toHaveLength(2)
      expect(fupPrompt[1].mimeType).toBe("image/jpeg")
    })
  })

  describe("doStream() — tool result resumption", () => {
    test("detects tool results in prompt and resumes pending turn", async () => {
      // This test simulates the full cycle:
      // 1. doStream() → tool call → stream closes with tool-calls
      // 2. doStream() with tool result → resumes → text → stream closes with stop

      const laneRouter = new LaneRouter()
      let resolvedResults: ToolResultRequest[] = []
      const mockIPC = createMockIPCServer({
        getLaneRouter: mock(() => laneRouter),
        resolveToolResult: mock((req: ToolResultRequest) => {
          resolvedResults.push(req)
        }),
      })

      let promptCallCount = 0
      let promptResolve: ((value: { stopReason: string }) => void) | null = null

      const client = createMockClient({
        getIPCServer: mock(() => mockIPC),
        getLaneRouter: mock(() => laneRouter),
        setPromptCallback: mock(() => {}),
        prompt: mock(async (opts: PromptOptions) => {
          promptCallCount++
          // First call: emit text, then tool call via IPC, then stay pending
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "Checking..." },
          })

          // Trigger tool call via lane router
          laneRouter.route({
            callId: "tc-resume",
            toolName: "bash",
            args: { command: "ls" },
          })

          // Return a promise that we control
          return new Promise<{ stopReason: string }>((resolve) => {
            promptResolve = resolve
          })
        }),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      // Step 1: First doStream — should get tool call and close
      const result1 = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "list files" }] }]),
      )

      const parts1 = await collectStream(result1.stream)
      const types1 = parts1.map((p) => p.type)

      expect(types1).toContain("tool-call")
      expect(types1).toContain("finish")

      const finish1 = parts1.find((p) => p.type === "finish")!
      if (finish1.type === "finish") {
        expect(finish1.finishReason.unified).toBe("tool-calls")
      }

      // Step 2: Resolve the prompt (simulating kiro continuing after tool result)
      // In real usage, resolveToolResult unblocks the MCP bridge which unblocks kiro
      setTimeout(() => {
        if (promptResolve) {
          promptResolve({ stopReason: "end_turn" })
        }
      }, 50)

      // Step 3: Second doStream with tool result
      const result2 = await model.doStream(
        makeCallOptions([
          { role: "user", content: [{ type: "text", text: "list files" }] },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "tc-resume",
                toolName: "bash",
                input: JSON.stringify({ command: "ls" }),
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "tc-resume",
                toolName: "bash",
                output: { type: "text" as const, value: "file1.ts\nfile2.ts" },
              },
            ],
          },
        ]),
      )

      const parts2 = await collectStream(result2.stream)
      const finish2 = parts2.find((p) => p.type === "finish")

      expect(finish2).toBeDefined()
      if (finish2?.type === "finish") {
        expect(finish2.finishReason.unified).toBe("stop")
      }

      // Verify the tool result was sent to IPC
      expect(resolvedResults).toHaveLength(1)
      expect(resolvedResults[0].callId).toBe("tc-resume")
      expect(resolvedResults[0].result).toBe("file1.ts\nfile2.ts")

      // Only one prompt call should have been made (the second doStream resumes)
      expect(promptCallCount).toBe(1)
    })
  })

  describe("ensureClient concurrency", () => {
    /**
     * Build a mock client whose `start` blocks on a manually-resolved gate.
     * This lets a test deterministically sequence two concurrent `doStream`
     * calls without any real timers — ordering is driven purely by resolving
     * the returned `resolveStart` function.
     */
    function createDeferredStartClient() {
      let running = false
      let startedToolless = false
      let stopCalls = 0
      const startCalls: (string | undefined)[] = []
      const toolsDir = createTempToolsDir()

      // Manually-resolved gate that the test releases to let `start` complete.
      let resolveStart!: () => void
      const startGate = new Promise<void>((resolve) => {
        resolveStart = resolve
      })

      const client = createMockClient({
        isRunning: mock(() => running),
        createSessionToolsFilePath: mock((id: string) => join(toolsDir, `tools-${id}.json`)),
        getCwd: mock(() => "/tmp/project"),
        start: mock(async (toolsFilePath?: string) => {
          startCalls.push(toolsFilePath)
          await startGate
          running = true
          return {
            agentInfo: { name: "kiro-cli", version: "1.0.0" },
            agentCapabilities: {},
          }
        }),
        stop: mock(async () => {
          stopCalls++
          running = false
          startedToolless = false
        }),
        prompt: mock(async (opts: PromptOptions) => {
          opts.onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "ok" },
          })
          return { stopReason: "end_turn" }
        }),
      } as unknown as Partial<ACPClient>)

      // Expose `startedToolless` as a getter/setter so reads/writes performed by
      // ensureClient() are observed against this mock's closure state.
      Object.defineProperty(client, "startedToolless", {
        get: () => startedToolless,
        set: (v: boolean) => {
          startedToolless = v
        },
        configurable: true,
      })

      return {
        client,
        startCalls,
        resolveStart,
        getStartedToolless: () => startedToolless,
        getStopCalls: () => stopCalls,
      }
    }

    test("tooled call arriving during a pending toolless start ends up tooled", async () => {
      // Arrange: one shared model + one deferred mock client, gate unresolved.
      const { client, startCalls, resolveStart, getStartedToolless, getStopCalls } =
        createDeferredStartClient()

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

      const tool: LanguageModelV3FunctionTool = {
        type: "function",
        name: "bash",
        description: "Execute a bash command",
        inputSchema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      }

      // Act A: kick off a toolless doStream — do NOT await. Its ensureClient()
      // acquires the lock and calls start(undefined), then blocks on startGate.
      const promiseA = model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "toolless" }] }]),
      )

      // Let A reach the blocked start() before B arrives. Microtask flush is
      // enough — start() is invoked synchronously up to the `await startGate`.
      await Promise.resolve()
      await Promise.resolve()

      // Act B: while A's start is pending, kick off a tooled doStream — do NOT
      // await yet. Its ensureClient() must wait on the client-level lock.
      const promiseB = model.doStream(
        makeCallOptions(
          [{ role: "user", content: [{ type: "text", text: "tooled" }] }],
          { tools: [tool] },
        ),
      )

      await Promise.resolve()
      await Promise.resolve()

      // Act: release the gate so A's start() completes; then drain both streams.
      resolveStart()

      const resA = await promiseA
      await collectStream(resA.stream)
      const resB = await promiseB
      await collectStream(resB.stream)

      // Assert: the effective tooled start carried a DEFINED toolsFilePath AND
      // stop() was called to restart the toolless client with tools.
      const definedStart = startCalls.find((p) => p !== undefined)
      expect(definedStart).toBeDefined()
      expect(getStopCalls()).toBeGreaterThanOrEqual(1)

      // The first start was the toolless one (undefined), proving the race
      // ordering was exercised and the fix restarted with tools afterward.
      expect(startCalls[0]).toBeUndefined()

      // Assert: startedToolless ends false (reset by stop() during restart).
      expect(getStartedToolless()).toBe(false)
    })

    test("two model instances sharing one client serialize readiness waits", async () => {
      const toolsDir = createTempToolsDir()
      const readinessResolvers: Array<(tools: Array<{ name: string; source: string }>) => void> = []
      let nextSession = 0
      const createSessionWithToolsPath = mock(async () => {
        nextSession++
        return {
          sessionId: `sess-${nextSession}`,
          modes: { currentModeId: "test-agent", availableModes: [] },
          models: { currentModelId: "claude-sonnet-4.6", availableModels: [] },
        } satisfies ACPSession
      })
      const waitForToolsReady = mock(
        () => new Promise<Array<{ name: string; source: string }>>((resolve) => {
          readinessResolvers.push(resolve)
        }),
      )
      const client = createMockClient({
        getAgentName: mock(() => "test-agent"),
        createSessionToolsFilePath: mock((id: string) => join(toolsDir, `tools-${id}.json`)),
        createSessionWithToolsPath,
        waitForToolsReady,
      } as unknown as Partial<ACPClient>)
      const withSessionSetupLock = client.withSessionSetupLock as unknown as ReturnType<typeof mock>
      const modelA = new KiroACPLanguageModel("claude-sonnet-4.6", { client })
      const modelB = new KiroACPLanguageModel("claude-sonnet-4.6", { client })
      const tools = [makeTool("task_complete", { type: "object", properties: {} })]
      const options = makeCallOptions(
        [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        { tools },
      )

      try {
        const resultAPromise = modelA.doStream(options)
        await waitForCondition(() => readinessResolvers.length === 1)

        const resultBPromise = modelB.doStream(options)
        await waitForCondition(() => withSessionSetupLock.mock.calls.length === 2)

        expect(withSessionSetupLock).toHaveBeenCalledTimes(2)
        expect(createSessionWithToolsPath).toHaveBeenCalledTimes(1)
        expect(waitForToolsReady).toHaveBeenCalledTimes(1)
        expect(readinessResolvers).toHaveLength(1)

        readinessResolvers[0]([{ name: "task_complete", source: "mcp:test" }])
        const resultA = await resultAPromise
        await waitForCondition(() => readinessResolvers.length === 2)

        expect(createSessionWithToolsPath).toHaveBeenCalledTimes(2)
        expect(waitForToolsReady).toHaveBeenCalledTimes(2)

        readinessResolvers[1]([{ name: "task_complete", source: "mcp:test" }])
        const resultB = await resultBPromise
        await Promise.all([collectStream(resultA.stream), collectStream(resultB.stream)])
      } finally {
        rmSync(toolsDir, { recursive: true, force: true })
      }
    })
  })

  describe("ephemeral client routing", () => {
    test("toolless doStream uses ephemeral client; tooled doStream uses main client", async () => {
      // Arrange: two independent mock clients — main + ephemeral. Each has
      // its own start/prompt mocks so we can observe which one was hit.
      const mainPrompt = mock(async (opts: PromptOptions) => {
        opts.onUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { text: "main" },
        })
        return { stopReason: "end_turn" }
      })
      const ephemeralPrompt = mock(async (opts: PromptOptions) => {
        opts.onUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { text: "ephemeral" },
        })
        return { stopReason: "end_turn" }
      })

      const mainClient = createMockClient({
        prompt: mainPrompt,
        createSessionToolsFilePath: mock((id: string) => join(createTempToolsDir(), `tools-${id}.json`)),
      } as unknown as Partial<ACPClient>)
      const ephemeralClient = createMockClient({
        prompt: ephemeralPrompt,
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("claude-sonnet-4.6", {
        client: mainClient,
        getEphemeralClient: () => ephemeralClient,
      })

      const tool: LanguageModelV3FunctionTool = {
        type: "function",
        name: "bash",
        description: "Execute a bash command",
        inputSchema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      }

      // Act 1: toolless doStream → must route to ephemeral client.
      const tolessResult = await model.doStream(
        makeCallOptions([{ role: "user", content: [{ type: "text", text: "title pls" }] }]),
      )
      await collectStream(tolessResult.stream)

      // Assert 1: ephemeral client was used; main client untouched.
      expect((ephemeralClient.start as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0)
      expect(ephemeralPrompt.mock.calls.length).toBe(1)
      expect((mainClient.start as ReturnType<typeof mock>).mock.calls.length).toBe(0)
      expect(mainPrompt.mock.calls.length).toBe(0)

      // Act 2: tooled doStream → must route to main client.
      const tooledResult = await model.doStream(
        makeCallOptions(
          [{ role: "user", content: [{ type: "text", text: "use the tool" }] }],
          { tools: [tool] },
        ),
      )
      await collectStream(tooledResult.stream)

      // Assert 2: main client was used for the tooled call; ephemeral counters
      // unchanged from after the toolless call.
      expect((mainClient.start as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0)
      expect(mainPrompt.mock.calls.length).toBe(1)
      expect(ephemeralPrompt.mock.calls.length).toBe(1) // unchanged
    })
  })
})
