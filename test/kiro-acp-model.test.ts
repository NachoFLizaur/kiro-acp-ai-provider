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
import { readFileSync, mkdirSync, mkdtempSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import * as childProcess from "node:child_process"

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
    prompt: mock(() => Promise.resolve({ stopReason: "end_turn" })),
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
    getIpcPort: mock(() => null),
    getIpcSecret: mock(() => null),
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

    test("relays configured effort and lets an explicit request override it", async () => {
      const setEffort = mock(async () => ({ success: true, message: "ok" }))
      const client = createMockClient({
        setEffort,
        prompt: completingPrompt(),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("Runtime/Exact.ID", {
        client,
        effort: "Configured/Effort",
      })

      await collectStream(
        (await model.doStream(
          makeCallOptions([{ role: "user", content: [{ type: "text", text: "hi" }] }]),
        )).stream,
      )
      await collectStream((await model.doStream(effortRequest("Requested/Effort"))).stream)

      expect(setEffort).toHaveBeenNthCalledWith(1, "sess-1", "Configured/Effort")
      expect(setEffort).toHaveBeenNthCalledWith(2, "sess-1", "Requested/Effort")
      expect(setEffort).toHaveBeenCalledTimes(2)
    })

    test("passes an opaque effort unchanged for an unfamiliar model", async () => {
      const setEffort = mock(async () => ({ success: true, message: "ok" }))
      const client = createMockClient({
        setEffort,
        prompt: completingPrompt(),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("future-runtime-model", { client })
      const opaqueEffort = "Future/MAX.v2+Beta!"

      const result = await model.doStream(effortRequest(opaqueEffort))
      await collectStream(result.stream)

      expect(setEffort).toHaveBeenCalledTimes(1)
      expect(setEffort).toHaveBeenCalledWith("sess-1", opaqueEffort)
    })

    test("treats an empty effort as the existing fail-soft no-op", async () => {
      const setEffort = mock(async () => ({ success: true, message: "ok" }))
      const client = createMockClient({
        setEffort,
        prompt: completingPrompt(),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("Runtime/Exact.ID", { client })

      const result = await model.doStream(effortRequest(""))
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

      const model = new KiroACPLanguageModel("Runtime/Exact.ID", { client })

      const result = await model.doStream(effortRequest("Rejected/Effort"))
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

      const model = new KiroACPLanguageModel("Runtime/Exact.ID", { client })

      const effort = "Stable/Effort"
      await collectStream((await model.doStream(effortRequest(effort))).stream)
      await collectStream((await model.doStream(effortRequest(effort))).stream)

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

      const model = new KiroACPLanguageModel("Runtime/Exact.ID", { client })

      const result = await model.doStream(effortRequest("Unavailable/Effort"))
      const parts = await collectStream(result.stream)

      // A rejected setEffort (vs the success:false case) must also be swallowed:
      // the turn finishes normally and no error part leaks into the stream.
      expect(setEffort).toHaveBeenCalledTimes(1)
      const finish = parts.find((p) => p.type === "finish")
      expect(finish?.type === "finish" && finish.finishReason.unified).toBe("stop")
      expect(parts.find((p) => p.type === "error")).toBeUndefined()
    })

    test("does not send an effort command when a request and configuration omit it", async () => {
      const setEffort = mock(async () => ({ success: true, message: "ok" }))
      const client = createMockClient({
        setEffort,
        prompt: completingPrompt(),
      } as unknown as Partial<ACPClient>)

      const model = new KiroACPLanguageModel("Runtime/Exact.ID", { client })
      await collectStream(
        (await model.doStream(
          makeCallOptions([{ role: "user", content: [{ type: "text", text: "hi" }] }]),
        )).stream,
      )
      expect(setEffort).not.toHaveBeenCalled()
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
            turnWallMs: expect.any(Number),
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
            turnWallMs: expect.any(Number),
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

  describe("extractPrompt — base64 conversion", () => {
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

  describe("extractPrompt — image handling", () => {
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

  describe("startFreshPrompt — ContentBlock[] wiring", () => {
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

// ---------------------------------------------------------------------------
// Stall watchdog
//
// Contract: when kiro-cli sends nothing for `stall.afterMs`, the turn counts
// as stalled. With `live: "reasoning"` (default) a reasoning fragment with its
// own id narrates the stall and is closed when output resumes or the turn
// ends. Whenever a turn stalled, the final text-end / reasoning-end carries
// `providerMetadata.kiro.status = { stalledMs, hint? }` next to the credits.
// No stall: no `status` key. `afterMs: 0` turns the whole feature off.
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Short silence threshold so the tests stay fast. */
const STALL_AFTER_MS = 100
/** Silence long enough for the watchdog to fire at least once, with margin. */
const STALL_GAP_MS = 260

const FIRST_NOTICE = "Kiro: no output for 0.1s - the model may be overloaded and kiro-cli is retrying."
const SECOND_NOTICE = "\nKiro: no output for 0.2s - the model may be overloaded and kiro-cli is retrying."

const USER_TURN: LanguageModelV3Prompt = [{ role: "user", content: [{ type: "text", text: "hello" }] }]

type PartWithMetadata = Extract<LanguageModelV3StreamPart, { providerMetadata?: unknown }>

/** The `kiro` record of a part's provider metadata, or undefined. */
function kiroOf(part: LanguageModelV3StreamPart | undefined): Record<string, unknown> | undefined {
  const metadata = (part as PartWithMetadata | undefined)?.providerMetadata as
    | { kiro?: Record<string, unknown> }
    | undefined
  return metadata?.kiro
}

/** Assert a well-formed stall status and return it. */
function expectStallStatus(kiro: Record<string, unknown> | undefined): { stalledMs: number; hint?: string } {
  expect(kiro).toBeDefined()
  const status = kiro!.status as { stalledMs: number; hint?: string } | undefined
  expect(status).toBeDefined()
  expect(typeof status!.stalledMs).toBe("number")
  expect(status!.stalledMs).toBeGreaterThanOrEqual(STALL_AFTER_MS)
  expect(status!.stalledMs).toBeLessThan(10_000)
  // Only the documented keys, ever
  for (const key of Object.keys(status!)) expect(["stalledMs", "hint"]).toContain(key)
  return status!
}

function partsOfType<T extends LanguageModelV3StreamPart["type"]>(
  parts: LanguageModelV3StreamPart[],
  type: T,
): Array<Extract<LanguageModelV3StreamPart, { type: T }>> {
  return parts.filter((p) => p.type === type) as Array<Extract<LanguageModelV3StreamPart, { type: T }>>
}

async function streamWithStall(
  client: ACPClient,
  stall: KiroACPModelConfig["stall"],
): Promise<LanguageModelV3StreamPart[]> {
  const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client, stall })
  const result = await model.doStream(makeCallOptions(USER_TURN))
  return collectStream(result.stream)
}

/**
 * Record every timer armed with exactly `delayMs` (the watchdog's own value,
 * chosen to be distinctive) and whether it later fired or was cleared. Real
 * timers keep running underneath, so behaviour is unchanged.
 */
function trackTimersWithDelay(delayMs: number) {
  const timers = new Map<unknown, { fired: boolean; cleared: boolean }>()
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const setSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
    fn: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    if (ms !== delayMs) return realSetTimeout(fn, ms, ...args)
    const entry = { fired: false, cleared: false }
    const handle = realSetTimeout(() => {
      entry.fired = true
      fn(...args)
    }, ms)
    timers.set(handle, entry)
    return handle
  }) as unknown as typeof setTimeout)
  const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(((handle: unknown) => {
    const entry = timers.get(handle)
    if (entry) entry.cleared = true
    return realClearTimeout(handle as Parameters<typeof clearTimeout>[0])
  }) as unknown as typeof clearTimeout)
  return {
    timers,
    restore() {
      setSpy.mockRestore()
      clearSpy.mockRestore()
    },
  }
}

describe("doStream() - stall watchdog", () => {
  test("narrates a stall before the first output and closes the notice when output resumes", async () => {
    // Arrange
    const client = createMockClient({
      prompt: mock(async (opts: PromptOptions) => {
        await sleep(STALL_GAP_MS)
        opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "late answer" } })
        return { stopReason: "end_turn" }
      }),
    } as unknown as Partial<ACPClient>)

    // Act
    const parts = await streamWithStall(client, { afterMs: STALL_AFTER_MS })
    const types = parts.map((p) => p.type)

    // Assert: stream-start exactly once, and first
    expect(types.filter((t) => t === "stream-start")).toHaveLength(1)
    expect(types[0]).toBe("stream-start")

    // The notice is its own reasoning fragment, opened before the text
    const noticeStarts = partsOfType(parts, "reasoning-start")
    expect(noticeStarts).toHaveLength(1)
    expect(noticeStarts[0].id).toBe("stall-0-1")

    const noticeDeltas = partsOfType(parts, "reasoning-delta")
      .filter((p) => p.id === "stall-0-1")
      .map((p) => p.delta)
    expect(noticeDeltas[0]).toBe(FIRST_NOTICE)
    expect(noticeDeltas.at(-1)).toMatch(/^\noutput resumed after \d+(\.\d)?s$/)

    const noticeEndIndex = parts.findIndex((p) => p.type === "reasoning-end" && p.id === "stall-0-1")
    const textStartIndex = types.indexOf("text-start")
    expect(noticeEndIndex).toBeGreaterThan(-1)
    expect(noticeEndIndex).toBeLessThan(textStartIndex)

    // A notice closed by resumed output carries no metadata itself
    expect(kiroOf(parts[noticeEndIndex])).toBeUndefined()

    // The final text-end reports the stall
    const textEnd = partsOfType(parts, "text-end")
    expect(textEnd).toHaveLength(1)
    expectStallStatus(kiroOf(textEnd[0]))
    expect(types).toContain("finish")
  })

  test("repeats the notice while the silence continues", async () => {
    // Arrange: silence for four thresholds before the first chunk
    const client = createMockClient({
      prompt: mock(async (opts: PromptOptions) => {
        await sleep(STALL_AFTER_MS * 4 + 60)
        opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "finally" } })
        return { stopReason: "end_turn" }
      }),
    } as unknown as Partial<ACPClient>)

    // Act
    const parts = await streamWithStall(client, { afterMs: STALL_AFTER_MS })

    // Assert: one fragment, several notices, then the resume line
    expect(partsOfType(parts, "reasoning-start")).toHaveLength(1)
    const deltas = partsOfType(parts, "reasoning-delta").map((p) => p.delta)
    const notices = deltas.filter((d) => d.includes("Kiro: no output for"))
    expect(notices.length).toBeGreaterThanOrEqual(2)
    expect(notices[0]).toBe(FIRST_NOTICE)
    expect(notices[1]).toBe(SECOND_NOTICE)
    expect(deltas.at(-1)).toMatch(/^\noutput resumed after/)
  })

  test("closes the text block for the notice and continues the text afterwards", async () => {
    // Arrange: text, silence, more text
    const client = createMockClient({
      prompt: mock(async (opts: PromptOptions) => {
        opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "Hello" } })
        await sleep(STALL_GAP_MS)
        opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: " world" } })
        return { stopReason: "end_turn" }
      }),
    } as unknown as Partial<ACPClient>)

    // Act
    const parts = await streamWithStall(client, { afterMs: STALL_AFTER_MS })
    const types = parts.map((p) => p.type)

    // Assert: the notice never lands inside the text block
    const noticeStart = types.indexOf("reasoning-start")
    const noticeEnd = types.indexOf("reasoning-end")
    const firstTextEnd = types.indexOf("text-end")
    const secondTextStart = types.lastIndexOf("text-start")
    expect(firstTextEnd).toBeLessThan(noticeStart)
    expect(noticeEnd).toBeLessThan(secondTextStart)

    // Text is delivered in full across the two segments
    const text = partsOfType(parts, "text-delta").map((p) => p.delta).join("")
    expect(text).toBe("Hello world")

    // Only the final text-end carries the status
    const textEnds = partsOfType(parts, "text-end")
    expect(textEnds).toHaveLength(2)
    expect(kiroOf(textEnds[0])).toBeUndefined()
    expectStallStatus(kiroOf(textEnds[1]))
    expect(types.filter((t) => t === "stream-start")).toHaveLength(1)
  })

  test("with live off, streams no notice but still reports the status", async () => {
    // Arrange
    const client = createMockClient({
      prompt: mock(async (opts: PromptOptions) => {
        await sleep(STALL_GAP_MS)
        opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "answer" } })
        return { stopReason: "end_turn" }
      }),
    } as unknown as Partial<ACPClient>)

    // Act
    const parts = await streamWithStall(client, { afterMs: STALL_AFTER_MS, live: "off" })
    const types = parts.map((p) => p.type)

    // Assert
    expect(types).not.toContain("reasoning-start")
    expect(types).not.toContain("reasoning-delta")
    expect(types).not.toContain("reasoning-end")
    const textEnd = partsOfType(parts, "text-end")[0]
    expectStallStatus(kiroOf(textEnd))
  })

  test("afterMs 0 disables the watchdog entirely", async () => {
    // Arrange
    const client = createMockClient({
      prompt: mock(async (opts: PromptOptions) => {
        await sleep(STALL_GAP_MS)
        opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "answer" } })
        return { stopReason: "end_turn" }
      }),
    } as unknown as Partial<ACPClient>)

    // Act
    const parts = await streamWithStall(client, { afterMs: 0 })
    const types = parts.map((p) => p.type)

    // Assert: no notice, no status, finish carries only the wall clock
    expect(types).not.toContain("reasoning-start")
    const textEnd = partsOfType(parts, "text-end")[0]
    expect(kiroOf(textEnd)).toBeUndefined()
    const finish = partsOfType(parts, "finish")[0]
    expect(finish.providerMetadata).toEqual({ kiro: { turnWallMs: expect.any(Number) } })
  })

  test("adds no status while output keeps arriving under the threshold", async () => {
    // Arrange: three chunks, each well within the threshold
    const client = createMockClient({
      prompt: mock(async (opts: PromptOptions) => {
        for (const text of ["one ", "two ", "three"]) {
          await sleep(40)
          opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text } })
        }
        return { stopReason: "end_turn" }
      }),
    } as unknown as Partial<ACPClient>)

    // Act
    const parts = await streamWithStall(client, { afterMs: 200 })
    const types = parts.map((p) => p.type)

    // Assert
    expect(types).not.toContain("reasoning-start")
    const textEnd = partsOfType(parts, "text-end")[0]
    expect(kiroOf(textEnd)).toBeUndefined()
    expect(types).toContain("finish")
  })

  test("attaches the status next to the credits on the final text-end", async () => {
    // Arrange
    const client = createMockClient({
      prompt: mock(async (opts: PromptOptions) => {
        await sleep(STALL_GAP_MS)
        opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "answer" } })
        return { stopReason: "end_turn" }
      }),
      getMetadata: mock(() => ({
        sessionId: "sess-1",
        turnDurationMs: 900,
        meteringUsage: [{ unit: "credit", unitPlural: "credits", value: 0.05 }],
      })),
    } as unknown as Partial<ACPClient>)

    // Act
    const parts = await streamWithStall(client, { afterMs: STALL_AFTER_MS })

    // Assert: one object carrying both
    const textEnd = partsOfType(parts, "text-end")[0]
    const kiro = kiroOf(textEnd)!
    expect(kiro.credits).toBe(0.05)
    expect(kiro.creditsUnit).toBe("credit")
    expectStallStatus(kiro)
    expect(Object.keys(kiro).sort()).toEqual(["credits", "creditsUnit", "status"])

    // Finish still mirrors credits and kiro's own duration untouched
    const finish = partsOfType(parts, "finish")[0]
    expect(finish.providerMetadata).toEqual({
      kiro: {
        contextUsagePercentage: null,
        turnDurationMs: 900,
        turnWallMs: expect.any(Number),
        credits: 0.05,
        creditsUnit: "credit",
      },
    })
  })

  test("reports the status even when the turn carries no credits", async () => {
    // Arrange: metadata present but no credit entry
    const client = createMockClient({
      prompt: mock(async (opts: PromptOptions) => {
        await sleep(STALL_GAP_MS)
        opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "answer" } })
        return { stopReason: "end_turn" }
      }),
      getMetadata: mock(() => ({
        sessionId: "sess-1",
        meteringUsage: [{ unit: "token", unitPlural: "tokens", value: 1000 }],
      })),
    } as unknown as Partial<ACPClient>)

    // Act
    const parts = await streamWithStall(client, { afterMs: STALL_AFTER_MS })

    // Assert: status alone, no credit keys invented
    const kiro = kiroOf(partsOfType(parts, "text-end")[0])!
    expectStallStatus(kiro)
    expect(Object.keys(kiro)).toEqual(["status"])
  })

  test("puts the same status on reasoning-end and text-end when both blocks close at the end", async () => {
    // Arrange: stall first, then reasoning and text without further gaps
    const client = createMockClient({
      prompt: mock(async (opts: PromptOptions) => {
        await sleep(STALL_GAP_MS)
        opts.onUpdate({ sessionUpdate: "agent_thought_chunk", content: { text: "thinking" } })
        opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "answer" } })
        return { stopReason: "end_turn" }
      }),
      getMetadata: mock(() => ({
        sessionId: "sess-1",
        meteringUsage: [{ unit: "credit", unitPlural: "credits", value: 0.07 }],
      })),
    } as unknown as Partial<ACPClient>)

    // Act
    const parts = await streamWithStall(client, { afterMs: STALL_AFTER_MS })

    // Assert: the model's own reasoning-end and the text-end carry one shape
    const modelReasoningEnd = partsOfType(parts, "reasoning-end").find((p) => p.id === "reasoning-0")
    const textEnd = partsOfType(parts, "text-end")[0]
    expect(modelReasoningEnd).toBeDefined()
    const onReasoning = kiroOf(modelReasoningEnd)
    const onText = kiroOf(textEnd)
    expectStallStatus(onReasoning)
    expect(onReasoning).toEqual(onText)
    expect(onText!.credits).toBe(0.07)

    // Exactly two parts carry the status: the dedupe rule stays two-per-turn
    const carriers = parts.filter((p) => kiroOf(p)?.status !== undefined)
    expect(carriers).toHaveLength(2)
  })

  test("closes the model's reasoning block before the notice when the stall hits mid-reasoning", async () => {
    // Arrange
    const client = createMockClient({
      prompt: mock(async (opts: PromptOptions) => {
        opts.onUpdate({ sessionUpdate: "agent_thought_chunk", content: { text: "thinking" } })
        await sleep(STALL_GAP_MS)
        opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "answer" } })
        return { stopReason: "end_turn" }
      }),
    } as unknown as Partial<ACPClient>)

    // Act
    const parts = await streamWithStall(client, { afterMs: STALL_AFTER_MS })

    // Assert: model reasoning closed (no metadata), then the notice, then text
    const modelReasoningEnd = parts.findIndex((p) => p.type === "reasoning-end" && p.id === "reasoning-0")
    const noticeStart = parts.findIndex((p) => p.type === "reasoning-start" && p.id === "stall-0-1")
    const noticeEnd = parts.findIndex((p) => p.type === "reasoning-end" && p.id === "stall-0-1")
    const textStart = parts.findIndex((p) => p.type === "text-start")
    expect(modelReasoningEnd).toBeGreaterThan(-1)
    expect(modelReasoningEnd).toBeLessThan(noticeStart)
    expect(noticeEnd).toBeLessThan(textStart)
    expect(kiroOf(parts[modelReasoningEnd])).toBeUndefined()

    // The text-end is the only part carrying the status
    const carriers = parts.filter((p) => kiroOf(p)?.status !== undefined)
    expect(carriers).toHaveLength(1)
    expect(carriers[0].type).toBe("text-end")
    expectStallStatus(kiroOf(carriers[0]))
  })

  test("reports the stall on the notice itself when the turn fails without further output", async () => {
    // Arrange
    const client = createMockClient({
      prompt: mock(async () => {
        await sleep(STALL_GAP_MS)
        throw new Error("boom")
      }),
    } as unknown as Partial<ACPClient>)

    // Act
    const parts = await streamWithStall(client, { afterMs: STALL_AFTER_MS })
    const types = parts.map((p) => p.type)

    // Assert: no text ever opened, so the notice fragment carries the status
    expect(types).not.toContain("text-start")
    expect(types).not.toContain("finish")
    const noticeDeltas = partsOfType(parts, "reasoning-delta").map((p) => p.delta)
    expect(noticeDeltas[0]).toBe(FIRST_NOTICE)
    expect(noticeDeltas.at(-1)).toMatch(/^\nturn ended after \d+(\.\d)?s without further output$/)

    const noticeEnd = partsOfType(parts, "reasoning-end").find((p) => p.id === "stall-0-1")
    const kiro = kiroOf(noticeEnd)!
    expectStallStatus(kiro)
    expect(Object.keys(kiro)).toEqual(["status"])

    const errorPart = partsOfType(parts, "error")[0]
    expect((errorPart.error as Error).message).toBe("boom")
    expect(types.indexOf("reasoning-end")).toBeLessThan(types.indexOf("error"))
  })

  test("reports the stall on a cancelled turn without reading credits", async () => {
    // Arrange
    const client = createMockClient({
      prompt: mock(async (opts: PromptOptions) => {
        await sleep(STALL_GAP_MS)
        opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "partial" } })
        return { stopReason: "cancelled" }
      }),
      getMetadata: mock(() => ({
        sessionId: "sess-1",
        meteringUsage: [{ unit: "credit", unitPlural: "credits", value: 0.05 }],
      })),
    } as unknown as Partial<ACPClient>)

    // Act
    const parts = await streamWithStall(client, { afterMs: STALL_AFTER_MS })
    const types = parts.map((p) => p.type)

    // Assert
    expect(types).not.toContain("finish")
    expect((partsOfType(parts, "error")[0].error as Error).message).toBe("Request was cancelled by user")
    const kiro = kiroOf(partsOfType(parts, "text-end")[0])!
    expectStallStatus(kiro)
    expect(Object.keys(kiro)).toEqual(["status"])
  })

  test("attaches the newest kiro-cli error line written during the turn as the hint", async () => {
    // Arrange: append a fresh ERROR line to the real kiro-cli log while the
    // turn is stalled, then trim the log back to its original size afterwards
    // so the developer's own log is left as it was.
    const { kiroChatLogPath } = await import("../src/kiro-log-hint")
    const { appendFileSync, statSync, truncateSync, unlinkSync, rmdirSync } = await import("node:fs")
    const { dirname } = await import("node:path")
    const logPath = kiroChatLogPath()
    const logDir = dirname(logPath)
    const dirExisted = existsSync(logDir)
    const fileExisted = existsSync(logPath)
    const originalSize = fileExisted ? statSync(logPath).size : 0
    if (!dirExisted) mkdirSync(logDir, { recursive: true })
    const marker = `test-marker-${Date.now().toString(36)}`

    const client = createMockClient({
      prompt: mock(async (opts: PromptOptions) => {
        // Stamped after the prompt started, so the reader accepts it
        const stamp = new Date().toISOString().replace("Z", "000Z")
        appendFileSync(
          logPath,
          `${stamp} \x1b[31mERROR\x1b[0m chat_cli_v2::agent::rts: failed to send rts request err=ModelOverloadedError ${marker}\n`,
        )
        await sleep(STALL_GAP_MS)
        opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "answer" } })
        return { stopReason: "end_turn" }
      }),
    } as unknown as Partial<ACPClient>)

    try {
      // Act
      const parts = await streamWithStall(client, { afterMs: STALL_AFTER_MS })

      // Assert
      const status = expectStallStatus(kiroOf(partsOfType(parts, "text-end")[0]))
      expect(status.hint).toBeDefined()
      expect(status.hint).toContain("ERROR chat_cli_v2::agent::rts: failed to send rts request")
      expect(status.hint).toContain(marker)
      expect(status.hint).not.toContain("\x1b")
      expect(status.hint!.length).toBeLessThanOrEqual(160)
    } finally {
      if (fileExisted) {
        truncateSync(logPath, originalSize)
      } else {
        try {
          unlinkSync(logPath)
        } catch {
          // Already gone
        }
        if (!dirExisted) {
          try {
            rmdirSync(logDir)
          } catch {
            // Not empty or already gone
          }
        }
      }
    }
  })

  test("carries the stall total across a tool-call segment to the final text-end", async () => {
    // Arrange: segment 1 stalls, then a tool call arrives; segment 2 resumes
    // with the tool result and finishes with text.
    const laneRouter = new LaneRouter()
    const mockIPC = createMockIPCServer({
      getLaneRouter: mock(() => laneRouter),
      resolveToolResult: mock(() => {}),
    })
    let promptResolve: ((value: { stopReason: string }) => void) | null = null
    let resumedOnUpdate: ((update: SessionUpdate) => void) | null = null

    const client = createMockClient({
      getIPCServer: mock(() => mockIPC),
      getLaneRouter: mock(() => laneRouter),
      setPromptCallback: mock((_sessionId: string, cb: (update: SessionUpdate) => void) => {
        resumedOnUpdate = cb
      }),
      prompt: mock(async () => {
        await sleep(STALL_GAP_MS)
        laneRouter.route({ callId: "tc-stall", toolName: "bash", args: { command: "ls" } })
        return new Promise<{ stopReason: string }>((resolve) => {
          promptResolve = resolve
        })
      }),
    } as unknown as Partial<ACPClient>)

    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client, stall: { afterMs: STALL_AFTER_MS } })

    // Act 1: first segment ends in a tool call
    const result1 = await model.doStream(makeCallOptions(USER_TURN))
    const parts1 = await collectStream(result1.stream)
    const types1 = parts1.map((p) => p.type)

    // Assert 1: the notice was closed by the tool call; no status on this segment
    expect(types1).toContain("tool-call")
    expect(partsOfType(parts1, "reasoning-start")[0].id).toBe("stall-0-1")
    expect(partsOfType(parts1, "reasoning-delta").map((p) => p.delta).at(-1)).toMatch(/^\noutput resumed after/)
    expect(parts1.some((p) => kiroOf(p)?.status !== undefined)).toBe(false)
    expect(partsOfType(parts1, "finish")[0].finishReason.unified).toBe("tool-calls")

    // Act 2: resume with the tool result; kiro answers promptly
    setTimeout(() => {
      resumedOnUpdate?.({ sessionUpdate: "agent_message_chunk", content: { text: "done" } })
      promptResolve?.({ stopReason: "end_turn" })
    }, 30)
    const result2 = await model.doStream(
      makeCallOptions([
        ...USER_TURN,
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "tc-stall", toolName: "bash", input: JSON.stringify({ command: "ls" }) }],
        },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "tc-stall", toolName: "bash", output: { type: "text" as const, value: "ok" } },
          ],
        },
      ]),
    )
    const parts2 = await collectStream(result2.stream)

    // Assert 2: no new stall in segment 2, yet the earlier total is reported
    expect(partsOfType(parts2, "reasoning-start")).toHaveLength(0)
    const textEnd = partsOfType(parts2, "text-end")[0]
    expectStallStatus(kiroOf(textEnd))
    expect(partsOfType(parts2, "finish")[0].finishReason.unified).toBe("stop")
  })

  describe("timer lifecycle", () => {
    const WATCHDOG_MS = 137

    test("leaves no armed watchdog timer after the turn finishes", async () => {
      const tracker = trackTimersWithDelay(WATCHDOG_MS)
      try {
        // Arrange
        const client = createMockClient({
          prompt: mock(async (opts: PromptOptions) => {
            opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "fast" } })
            return { stopReason: "end_turn" }
          }),
        } as unknown as Partial<ACPClient>)

        // Act
        const parts = await streamWithStall(client, { afterMs: WATCHDOG_MS })

        // Assert: the watchdog was armed, and every arming was cleared or fired
        expect(parts.map((p) => p.type)).toContain("finish")
        expect(tracker.timers.size).toBeGreaterThan(0)
        for (const entry of tracker.timers.values()) {
          expect(entry.cleared || entry.fired).toBe(true)
        }
        // Nothing fires late: no notice was ever produced for a fast turn
        await sleep(WATCHDOG_MS + 60)
        for (const entry of tracker.timers.values()) expect(entry.fired).toBe(false)
      } finally {
        tracker.restore()
      }
    })

    test("leaves no armed watchdog timer after the turn fails", async () => {
      const tracker = trackTimersWithDelay(WATCHDOG_MS)
      try {
        const client = createMockClient({
          prompt: mock(async () => {
            throw new Error("boom")
          }),
        } as unknown as Partial<ACPClient>)

        const parts = await streamWithStall(client, { afterMs: WATCHDOG_MS })

        expect(parts.map((p) => p.type)).toContain("error")
        expect(tracker.timers.size).toBeGreaterThan(0)
        for (const entry of tracker.timers.values()) {
          expect(entry.cleared || entry.fired).toBe(true)
        }
        await sleep(WATCHDOG_MS + 60)
        for (const entry of tracker.timers.values()) expect(entry.fired).toBe(false)
      } finally {
        tracker.restore()
      }
    })

    test("leaves no armed watchdog timer after tool calls are flushed", async () => {
      const tracker = trackTimersWithDelay(WATCHDOG_MS)
      const laneRouter = new LaneRouter()
      let promptResolve: ((value: { stopReason: string }) => void) | null = null
      try {
        const client = createMockClient({
          getLaneRouter: mock(() => laneRouter),
          prompt: mock(async (opts: PromptOptions) => {
            opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "Let me check" } })
            laneRouter.route({ callId: "tc-timer", toolName: "bash", args: { command: "ls" } })
            return new Promise<{ stopReason: string }>((resolve) => {
              promptResolve = resolve
            })
          }),
        } as unknown as Partial<ACPClient>)

        const parts = await streamWithStall(client, { afterMs: WATCHDOG_MS })

        // The segment closed on the tool call; the prompt itself is still pending
        expect(parts.map((p) => p.type)).toContain("tool-call")
        expect(tracker.timers.size).toBeGreaterThan(0)
        for (const entry of tracker.timers.values()) {
          expect(entry.cleared || entry.fired).toBe(true)
        }
        await sleep(WATCHDOG_MS + 60)
        for (const entry of tracker.timers.values()) expect(entry.fired).toBe(false)
      } finally {
        tracker.restore()
        promptResolve?.({ stopReason: "end_turn" })
        await sleep(10)
      }
    })
  })
})

// ---------------------------------------------------------------------------
// turnWallMs on the finish part
// ---------------------------------------------------------------------------

describe("doStream() - turnWallMs", () => {
  test("reports the provider-measured wall clock next to kiro's own duration", async () => {
    // Arrange: kiro reports its own figure; the provider measures independently
    const client = createMockClient({
      prompt: mock(async (opts: PromptOptions) => {
        await sleep(120)
        opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "answer" } })
        return { stopReason: "end_turn" }
      }),
      getMetadata: mock(() => ({ sessionId: "sess-1", turnDurationMs: 2500 })),
    } as unknown as Partial<ACPClient>)
    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

    // Act
    const result = await model.doStream(makeCallOptions(USER_TURN))
    const parts = await collectStream(result.stream)

    // Assert
    const kiro = kiroOf(partsOfType(parts, "finish")[0])!
    expect(kiro.turnDurationMs).toBe(2500)
    expect(typeof kiro.turnWallMs).toBe("number")
    expect(kiro.turnWallMs as number).toBeGreaterThanOrEqual(100)
    expect(kiro.turnWallMs as number).toBeLessThan(10_000)
  })

  test("is the only key when kiro-cli reports no session metadata", async () => {
    // Arrange
    const client = createMockClient({
      prompt: mock(async (opts: PromptOptions) => {
        opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "answer" } })
        return { stopReason: "end_turn" }
      }),
    } as unknown as Partial<ACPClient>)
    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

    // Act
    const result = await model.doStream(makeCallOptions(USER_TURN))
    const parts = await collectStream(result.stream)

    // Assert: no fabricated turnDurationMs, context usage or credit keys
    const finish = partsOfType(parts, "finish")[0]
    expect(finish.providerMetadata).toEqual({ kiro: { turnWallMs: expect.any(Number) } })
    const kiro = kiroOf(finish)!
    expect(Object.keys(kiro)).toEqual(["turnWallMs"])
    expect(kiro.turnWallMs as number).toBeGreaterThanOrEqual(0)
  })

  test("keeps the null fallback for turnDurationMs when kiro reports metadata without it", async () => {
    // Arrange
    const client = createMockClient({
      prompt: mock(async (opts: PromptOptions) => {
        opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "answer" } })
        return { stopReason: "end_turn" }
      }),
      getMetadata: mock(() => ({ sessionId: "sess-1", contextUsagePercentage: 0.1 })),
    } as unknown as Partial<ACPClient>)
    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

    // Act
    const result = await model.doStream(makeCallOptions(USER_TURN))
    const parts = await collectStream(result.stream)

    // Assert
    const kiro = kiroOf(partsOfType(parts, "finish")[0])!
    expect(kiro.turnDurationMs).toBeNull()
    expect(typeof kiro.turnWallMs).toBe("number")
  })
})
