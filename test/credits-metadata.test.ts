import { describe, test, expect, mock } from "bun:test"
import { KiroACPLanguageModel } from "../src/kiro-acp-model"
import { LaneRouter } from "../src/lane-router"
import type { ACPClient, ACPSession, PromptOptions, SessionMetadata } from "../src/acp-client"
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"

// ---------------------------------------------------------------------------
// Credits part-level dual emission.
//
// Contract: completed turns with known credits attach the same
// `{ kiro: { credits, creditsUnit } }` provider metadata to the final
// text-end and to reasoning-end (when the turn streamed reasoning).
// No `kiro` key leaks onto parts when credits are unknown, the turn was
// cancelled, a mid-turn tool-call segment is flushed, or the prompt errored.
// doGenerate mirrors the part metadata onto its content parts and keeps the
// full finish-event shape at the result level.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal mock ACPClient (same shape as kiro-acp-model.test.ts). */
function createMockClient(overrides: Partial<ACPClient> = {}): ACPClient {
  const mockLaneRouter = new LaneRouter()
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
    getMetadata: mock(() => undefined),
    getStderr: mock(() => ""),
    getToolsFilePath: mock(() => null),
    getCwd: mock(() => "/tmp/test"),
    getAgentName: mock(() => undefined),
    getIpcPort: mock(() => null),
    getIpcSecret: mock(() => null),
    getIPCServer: mock(() => null),
    getLaneRouter: mock(() => mockLaneRouter),
    setPromptCallback: mock(() => {}),
    waitForToolsReady: mock(() => Promise.resolve()),
    getOrCreateToolsFilePath: mock(() => "/tmp/tools.json"),
    createSessionToolsFilePath: mock((id: string) => `/tmp/kiro-acp/tools-test-${id}.json`),
    removeSessionToolsFile: mock(() => {}),
    ...overrides,
  } as unknown as ACPClient
}

/**
 * Mock client whose prompt streams the given updates and finishes with
 * `stopReason`, while `getMetadata` reports the given session metadata.
 */
function clientWithTurn(params: {
  updates?: Array<{ kind: "text" | "thought"; text: string }>
  stopReason?: string
  metadata?: Partial<SessionMetadata>
  rejectWith?: Error
}): ACPClient {
  return createMockClient({
    prompt: mock(async (opts: PromptOptions) => {
      for (const u of params.updates ?? []) {
        opts.onUpdate({
          sessionUpdate: u.kind === "text" ? "agent_message_chunk" : "agent_thought_chunk",
          content: { text: u.text },
        })
      }
      if (params.rejectWith) throw params.rejectWith
      return { stopReason: params.stopReason ?? "end_turn" }
    }),
    getMetadata: mock(() =>
      params.metadata ? ({ sessionId: "sess-1", ...params.metadata } as SessionMetadata) : undefined,
    ),
  } as unknown as Partial<ACPClient>)
}

function makeCallOptions(
  prompt: LanguageModelV3Prompt,
  overrides: Partial<LanguageModelV3CallOptions> = {},
): LanguageModelV3CallOptions {
  return { prompt, ...overrides } as LanguageModelV3CallOptions
}

const USER_PROMPT: LanguageModelV3Prompt = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
]

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

async function streamParts(client: ACPClient): Promise<LanguageModelV3StreamPart[]> {
  const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })
  const result = await model.doStream(makeCallOptions(USER_PROMPT))
  return collectStream(result.stream)
}

const CREDITS_METADATA = {
  contextUsagePercentage: 0.42,
  turnDurationMs: 1234,
  meteringUsage: [{ unit: "credit", unitPlural: "credits", value: 0.05 }],
}

// ---------------------------------------------------------------------------
// doStream — part-level emission
// ---------------------------------------------------------------------------

describe("doStream — credits on part-end metadata", () => {
  test("final text-end carries kiro credits metadata", async () => {
    const parts = await streamParts(
      clientWithTurn({ updates: [{ kind: "text", text: "answer" }], metadata: CREDITS_METADATA }),
    )

    const textEnd = parts.find((p) => p.type === "text-end")
    expect(textEnd).toBeDefined()
    if (textEnd?.type === "text-end") {
      expect(textEnd.providerMetadata).toEqual({
        kiro: { credits: 0.05, creditsUnit: "credit" },
      })
    }
  })

  test("reasoning-end carries the same kiro credits metadata when reasoning streamed", async () => {
    const parts = await streamParts(
      clientWithTurn({
        updates: [
          { kind: "thought", text: "thinking..." },
          { kind: "text", text: "answer" },
        ],
        metadata: { meteringUsage: [{ unit: "credit", unitPlural: "credits", value: 0.07 }] },
      }),
    )

    const reasoningEnd = parts.find((p) => p.type === "reasoning-end")
    const textEnd = parts.find((p) => p.type === "text-end")
    expect(reasoningEnd).toBeDefined()
    expect(textEnd).toBeDefined()

    if (reasoningEnd?.type === "reasoning-end" && textEnd?.type === "text-end") {
      const expected = { kiro: { credits: 0.07, creditsUnit: "credit" } }
      // DUAL EMISSION: both ends carry the same turn total
      expect(reasoningEnd.providerMetadata).toEqual(expected)
      expect(textEnd.providerMetadata).toEqual(expected)
    }
  })

  test("no credit metering entry → no kiro key on any part-end (finish keeps nulls)", async () => {
    // Metadata exists but has no credit-unit entry (e.g. token metering only)
    const parts = await streamParts(
      clientWithTurn({
        updates: [{ kind: "text", text: "answer" }],
        metadata: {
          turnDurationMs: 3200,
          meteringUsage: [{ unit: "token", unitPlural: "tokens", value: 1000 }],
        },
      }),
    )

    const textEnd = parts.find((p) => p.type === "text-end")
    expect(textEnd).toBeDefined()
    if (textEnd?.type === "text-end") {
      expect(textEnd.providerMetadata).toBeUndefined()
    }

    // Finish-event mirror still reports the turn with null credits
    const finish = parts.find((p) => p.type === "finish")
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

  test("no session metadata at all → no kiro key on parts, finish carries only the wall clock", async () => {
    const parts = await streamParts(
      clientWithTurn({ updates: [{ kind: "text", text: "answer" }] }),
    )

    const textEnd = parts.find((p) => p.type === "text-end")
    if (textEnd?.type === "text-end") {
      expect(textEnd.providerMetadata).toBeUndefined()
    }
    // Without kiro-reported metadata nothing is invented: no turnDurationMs,
    // no context usage, no credit keys. Only the provider's own wall clock.
    const finish = parts.find((p) => p.type === "finish")
    if (finish?.type === "finish") {
      expect(finish.providerMetadata).toEqual({
        kiro: { turnWallMs: expect.any(Number) },
      })
    }
  })

  test("non-finite credits value → no kiro key on parts", async () => {
    const parts = await streamParts(
      clientWithTurn({
        updates: [{ kind: "text", text: "answer" }],
        metadata: { meteringUsage: [{ unit: "credit", unitPlural: "credits", value: Number.NaN }] },
      }),
    )

    const textEnd = parts.find((p) => p.type === "text-end")
    expect(textEnd).toBeDefined()
    if (textEnd?.type === "text-end") {
      expect(textEnd.providerMetadata).toBeUndefined()
    }
  })

  test("cancelled turn → no kiro key on text-end even when metering is available", async () => {
    // getMetadata WOULD return credits — the cancel path must never read it
    const parts = await streamParts(
      clientWithTurn({
        updates: [{ kind: "text", text: "partial answ" }],
        stopReason: "cancelled",
        metadata: CREDITS_METADATA,
      }),
    )

    const textEnd = parts.find((p) => p.type === "text-end")
    expect(textEnd).toBeDefined()
    if (textEnd?.type === "text-end") {
      expect(textEnd.providerMetadata).toBeUndefined()
    }
    expect(parts.some((p) => p.type === "error")).toBe(true)
    expect(parts.some((p) => p.type === "finish")).toBe(false)
  })

  test("prompt error → text-end closes without kiro metadata, error part follows", async () => {
    const parts = await streamParts(
      clientWithTurn({
        updates: [{ kind: "text", text: "partial" }],
        metadata: CREDITS_METADATA,
        rejectWith: new Error("boom"),
      }),
    )

    const textEnd = parts.find((p) => p.type === "text-end")
    expect(textEnd).toBeDefined()
    if (textEnd?.type === "text-end") {
      expect(textEnd.providerMetadata).toBeUndefined()
    }
    const errorPart = parts.find((p) => p.type === "error")
    expect(errorPart).toBeDefined()
    if (errorPart?.type === "error") {
      expect((errorPart.error as Error).message).toBe("boom")
    }
  })

  test("mid-turn tool-call segment flush → no kiro metadata on its text-end or finish", async () => {
    const laneRouter = new LaneRouter()
    const client = createMockClient({
      getLaneRouter: mock(() => laneRouter),
      // Credits ARE reported by the client — but a segment that ends in
      // tool-calls is not a completed turn, so nothing may leak onto parts
      getMetadata: mock(() => ({ sessionId: "sess-1", ...CREDITS_METADATA })),
      prompt: mock(async (opts: PromptOptions) => {
        opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "Let me check..." } })
        laneRouter.route({ callId: "tc-1", toolName: "bash", args: { command: "ls" } })
        // Prompt stays pending while kiro waits on the MCP bridge
        await new Promise((r) => setTimeout(r, 200))
        return { stopReason: "end_turn" }
      }),
    } as unknown as Partial<ACPClient>)

    const parts = await streamParts(client)

    expect(parts.some((p) => p.type === "tool-call")).toBe(true)

    const textEnd = parts.find((p) => p.type === "text-end")
    expect(textEnd).toBeDefined()
    if (textEnd?.type === "text-end") {
      expect(textEnd.providerMetadata).toBeUndefined()
    }

    const finish = parts.find((p) => p.type === "finish")
    expect(finish).toBeDefined()
    if (finish?.type === "finish") {
      expect(finish.finishReason.unified).toBe("tool-calls")
      expect(finish.providerMetadata).toBeUndefined()
    }
  })

  test("finish event keeps the FULL shape while parts carry only the slim credits shape", async () => {
    const parts = await streamParts(
      clientWithTurn({ updates: [{ kind: "text", text: "answer" }], metadata: CREDITS_METADATA }),
    )

    const textEnd = parts.find((p) => p.type === "text-end")
    const finish = parts.find((p) => p.type === "finish")

    if (textEnd?.type === "text-end") {
      expect(textEnd.providerMetadata).toEqual({
        kiro: { credits: 0.05, creditsUnit: "credit" },
      })
    }
    if (finish?.type === "finish") {
      expect(finish.providerMetadata).toEqual({
        kiro: {
          contextUsagePercentage: 0.42,
          turnDurationMs: 1234,
          turnWallMs: expect.any(Number),
          credits: 0.05,
          creditsUnit: "credit",
        },
      })
    }
  })
})

// ---------------------------------------------------------------------------
// doGenerate — mirrors the stream's part metadata onto content parts
// ---------------------------------------------------------------------------

describe("doGenerate — credits mirroring", () => {
  test("mirrors kiro credits onto reasoning + text content parts and keeps result metadata", async () => {
    const client = clientWithTurn({
      updates: [
        { kind: "thought", text: "let me think" },
        { kind: "text", text: "the answer" },
      ],
      metadata: CREDITS_METADATA,
    })
    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

    const result = await model.doGenerate(makeCallOptions(USER_PROMPT))

    const partMetadata = { kiro: { credits: 0.05, creditsUnit: "credit" } }
    expect(result.content).toEqual([
      { type: "reasoning", text: "let me think", providerMetadata: partMetadata },
      { type: "text", text: "the answer", providerMetadata: partMetadata },
    ])
    expect(result.providerMetadata).toEqual({
      kiro: {
        contextUsagePercentage: 0.42,
        turnDurationMs: 1234,
        turnWallMs: expect.any(Number),
        credits: 0.05,
        creditsUnit: "credit",
      },
    })
    expect(result.finishReason.unified).toBe("stop")
  })

  test("no metadata → content parts carry no provider metadata, result carries only the wall clock", async () => {
    const client = clientWithTurn({ updates: [{ kind: "text", text: "plain" }] })
    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

    const result = await model.doGenerate(makeCallOptions(USER_PROMPT))

    expect(result.content).toEqual([{ type: "text", text: "plain" }])
    expect(result.providerMetadata).toEqual({
      kiro: { turnWallMs: expect.any(Number) },
    })
  })
})
