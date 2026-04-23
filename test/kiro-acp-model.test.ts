import { describe, test, expect, mock, beforeEach } from "bun:test"
import { KiroACPLanguageModel, type KiroACPModelConfig } from "../src/kiro-acp-model"
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
import { readFileSync, mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

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
  return {
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
      const toolsDir = join(tmpdir(), `kiro-acp-test-${Date.now()}`)
      mkdirSync(toolsDir, { recursive: true })
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
      const toolsDir = join(tmpdir(), `kiro-acp-test-${Date.now()}`)
      mkdirSync(toolsDir, { recursive: true })
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
      const toolsDir = join(tmpdir(), `kiro-acp-test-${Date.now()}`)
      mkdirSync(toolsDir, { recursive: true })
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
      const toolsDir = join(tmpdir(), `kiro-acp-test-${Date.now()}`)
      mkdirSync(toolsDir, { recursive: true })
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
      const toolsDir = join(tmpdir(), `kiro-acp-test-${Date.now()}`)
      mkdirSync(toolsDir, { recursive: true })
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
      const toolsDir = join(tmpdir(), `kiro-acp-test-${Date.now()}`)
      mkdirSync(toolsDir, { recursive: true })

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
      const toolsDir = join(tmpdir(), `kiro-acp-test-${Date.now()}`)
      mkdirSync(toolsDir, { recursive: true })

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
      const toolsDir = join(tmpdir(), `kiro-acp-test-${Date.now()}`)
      mkdirSync(toolsDir, { recursive: true })
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
})
