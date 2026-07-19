import { describe, test, expect, mock } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import {
  interceptSessionAffinity,
  hashPromptMessages,
  diverged,
} from "../src/session-affinity"
import { KiroACPLanguageModel } from "../src/kiro-acp-model"
import { createKiroAcp } from "../src/kiro-acp-provider"
import { LaneRouter } from "../src/lane-router"
import type { ACPClient, ACPSession, PromptOptions } from "../src/acp-client"
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import { tmpdir } from "node:os"

// ---------------------------------------------------------------------------
// Session-affinity intercept — behavioral parity with opencode core's custom
// kiro loader (`packages/opencode/src/provider/provider.ts:936-1015`).
//
// These tests are the parity SPEC for the port: each core rule (pass-through,
// first-call history reset, prefix continuation, divergence, truncation,
// ephemeral keying, hash normalization) is encoded as a scenario. If these
// pass but E2E resets misbehave, suspect header plumbing — not hashing.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build call options with a prompt and optional headers/tools. */
function makeOptions(
  prompt: LanguageModelV3Prompt,
  overrides: Partial<LanguageModelV3CallOptions> = {},
): LanguageModelV3CallOptions {
  return { prompt, ...overrides } as LanguageModelV3CallOptions
}

const TOOL = {
  type: "function",
  name: "bash",
  description: "run a command",
  inputSchema: { type: "object", properties: {} },
} as const

function user(text: string): LanguageModelV3Prompt[number] {
  return { role: "user", content: [{ type: "text", text }] }
}

function assistant(text: string): LanguageModelV3Prompt[number] {
  return { role: "assistant", content: [{ type: "text", text }] }
}

function system(text: string): LanguageModelV3Prompt[number] {
  return { role: "system", content: text }
}

/** Unique affinity id per test so persisted-session files from previous runs can never leak in. */
function uniqueAffinity(): string {
  return `aff-${randomBytes(6).toString("hex")}`
}

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
    withSessionSetupLock: mock(async <T,>(fn: () => Promise<T>): Promise<T> => fn()),
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
    getCwd: mock(() => tmpdir()),
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

/** Drain a stream so the doStream lifecycle completes. */
async function drainStream(stream: ReadableStream<LanguageModelV3StreamPart>): Promise<void> {
  const reader = stream.getReader()
  for (;;) {
    const { done } = await reader.read()
    if (done) break
  }
}

// ---------------------------------------------------------------------------
// interceptSessionAffinity — pure helper behavior
// ---------------------------------------------------------------------------

describe("interceptSessionAffinity — pass-through", () => {
  test("no affinity header → options returned unchanged (same reference), nothing tracked", () => {
    const prompts = new Map<string, string[]>()
    const options = makeOptions([user("hello")], {
      headers: { "x-other": "value" },
      tools: [TOOL],
    })

    const result = interceptSessionAffinity(options, prompts)

    expect(result).toBe(options)
    expect(prompts.size).toBe(0)
  })

  test("undefined headers object → same reference, nothing tracked", () => {
    const prompts = new Map<string, string[]>()
    const options = makeOptions([user("hello")])

    const result = interceptSessionAffinity(options, prompts)

    expect(result).toBe(options)
    expect(prompts.size).toBe(0)
  })
})

describe("interceptSessionAffinity — first call semantics", () => {
  test("first call without history → no reset, key tracked, original options returned", () => {
    const prompts = new Map<string, string[]>()
    const options = makeOptions([system("be nice"), user("hello")], {
      headers: { "x-session-affinity": "aff-1" },
      tools: [TOOL],
    })

    const result = interceptSessionAffinity(options, prompts)

    // Non-ephemeral + no reset → core provider.ts:988 returns the SAME object
    expect(result).toBe(options)
    expect(result.headers?.["x-session-reset"]).toBeUndefined()
    // Key tracked with one hash per non-system message
    expect(prompts.has("aff-1")).toBe(true)
    expect(prompts.get("aff-1")).toHaveLength(1)
  })

  test("first call WITH history → reset (core provider.ts:980-981)", () => {
    const prompts = new Map<string, string[]>()
    const options = makeOptions(
      [system("sys"), user("q1"), assistant("a1"), user("q2")],
      { headers: { "x-session-affinity": "aff-1" }, tools: [TOOL] },
    )

    const result = interceptSessionAffinity(options, prompts)

    expect(result).not.toBe(options)
    expect(result.headers?.["x-session-affinity"]).toBe("aff-1")
    expect(result.headers?.["x-session-reset"]).toBe("true")
    // Original options object must NOT be mutated
    expect(options.headers?.["x-session-reset"]).toBeUndefined()
    // Messages tracked so the NEXT call can be a continuation
    expect(prompts.get("aff-1")).toHaveLength(3)
  })

  test("tool messages count as history on first call → reset", () => {
    const prompts = new Map<string, string[]>()
    const options = makeOptions(
      [
        user("q1"),
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "t1",
              toolName: "bash",
              output: { type: "text", value: "ok" },
            },
          ],
        } as LanguageModelV3Prompt[number],
      ],
      { headers: { "x-session-affinity": "aff-1" }, tools: [TOOL] },
    )

    const result = interceptSessionAffinity(options, prompts)

    expect(result.headers?.["x-session-reset"]).toBe("true")
  })
})

describe("interceptSessionAffinity — continuation and divergence", () => {
  test("prefix continuation → no reset, ORIGINAL options reference (core provider.ts:988)", () => {
    const prompts = new Map<string, string[]>()
    const headers = { "x-session-affinity": "aff-1" }

    interceptSessionAffinity(makeOptions([user("q1")], { headers, tools: [TOOL] }), prompts)

    const turn2 = makeOptions([user("q1"), assistant("a1"), user("q2")], {
      headers,
      tools: [TOOL],
    })
    const result = interceptSessionAffinity(turn2, prompts)

    expect(result).toBe(turn2)
    expect(result.headers?.["x-session-reset"]).toBeUndefined()
    // Tracking advanced to the new 3-message state
    expect(prompts.get("aff-1")).toHaveLength(3)
  })

  test("divergence (changed earlier message) → reset", () => {
    const prompts = new Map<string, string[]>()
    const headers = { "x-session-affinity": "aff-1" }

    // Turn 1 tracks one message; turn 2 extends it to three
    interceptSessionAffinity(makeOptions([user("q1")], { headers, tools: [TOOL] }), prompts)
    interceptSessionAffinity(
      makeOptions([user("q1"), assistant("a1"), user("q2")], { headers, tools: [TOOL] }),
      prompts,
    )

    // Third call rewrites the FIRST message (e.g. revert + new edit)
    const turn3 = makeOptions([user("REVISED"), assistant("a1"), user("q3")], {
      headers,
      tools: [TOOL],
    })
    const result = interceptSessionAffinity(turn3, prompts)

    expect(result).not.toBe(turn3)
    expect(result.headers?.["x-session-reset"]).toBe("true")
    // Affinity header itself is untouched for non-ephemeral calls
    expect(result.headers?.["x-session-affinity"]).toBe("aff-1")
  })

  test("truncation (fewer messages than tracked) → reset (core provider.ts:947)", () => {
    const prompts = new Map<string, string[]>()
    const headers = { "x-session-affinity": "aff-1" }

    // Seed: 3 tracked messages (first call has history → reset expected, ignored)
    interceptSessionAffinity(
      makeOptions([user("q1"), assistant("a1"), user("q2")], { headers, tools: [TOOL] }),
      prompts,
    )

    // Revert dropped the conversation back to just the first message
    const result = interceptSessionAffinity(
      makeOptions([user("q1")], { headers, tools: [TOOL] }),
      prompts,
    )

    expect(result.headers?.["x-session-reset"]).toBe("true")
    // Tracking replaced with the truncated state
    expect(prompts.get("aff-1")).toHaveLength(1)
  })
})

describe("interceptSessionAffinity — ephemeral (toolless) keying", () => {
  test("tools: [] → key rewritten to <id>:ephemeral in header, tracked separately", () => {
    const prompts = new Map<string, string[]>()

    // Tooled conversation already tracked under the plain key
    interceptSessionAffinity(
      makeOptions([user("main convo")], {
        headers: { "x-session-affinity": "aff-1" },
        tools: [TOOL],
      }),
      prompts,
    )
    const tooledHashes = prompts.get("aff-1")

    // Toolless call (e.g. title generation) on the same affinity
    const ephemeralOptions = makeOptions([user("generate a title")], {
      headers: { "x-session-affinity": "aff-1" },
      tools: [],
    })
    const result = interceptSessionAffinity(ephemeralOptions, prompts)

    // Header REWRITTEN to the ephemeral key (core provider.ts:957-959,985)
    expect(result).not.toBe(ephemeralOptions)
    expect(result.headers?.["x-session-affinity"]).toBe("aff-1:ephemeral")
    expect(result.headers?.["x-session-reset"]).toBeUndefined()
    // Original options object not mutated
    expect(ephemeralOptions.headers?.["x-session-affinity"]).toBe("aff-1")

    // Separate tracking: tooled key untouched, ephemeral key added
    expect(prompts.get("aff-1")).toBe(tooledHashes!)
    expect(prompts.has("aff-1:ephemeral")).toBe(true)
    expect(prompts.size).toBe(2)
  })

  test("absent tools field → treated as ephemeral", () => {
    const prompts = new Map<string, string[]>()
    const options = makeOptions([user("hi")], {
      headers: { "x-session-affinity": "aff-2" },
    })

    const result = interceptSessionAffinity(options, prompts)

    expect(result.headers?.["x-session-affinity"]).toBe("aff-2:ephemeral")
    expect(prompts.has("aff-2:ephemeral")).toBe(true)
  })

  test("legacy mode.tools fallback → non-empty mode.tools is NOT ephemeral", () => {
    const prompts = new Map<string, string[]>()
    const options = makeOptions([user("hi")], {
      headers: { "x-session-affinity": "aff-3" },
    })
    ;(options as { mode?: { tools?: unknown[] } }).mode = { tools: [TOOL] }

    const result = interceptSessionAffinity(options, prompts)

    // Non-ephemeral + first call without history → original reference, plain key
    expect(result).toBe(options)
    expect(prompts.has("aff-3")).toBe(true)
    expect(prompts.has("aff-3:ephemeral")).toBe(false)
  })
})

describe("hashPromptMessages — normalization (core provider.ts:960-978)", () => {
  test("pinned SHA-1 vector — bit-identical to core Hash.fast over the normalized payload", () => {
    const hashes = hashPromptMessages([user("hello")])

    // sha1(JSON.stringify({ r: "user", c: [{ t: "text", v: "hello" }] }))
    const expected = createHash("sha1")
      .update(JSON.stringify({ r: "user", c: [{ t: "text", v: "hello" }] }))
      .digest("hex")
    expect(hashes).toEqual([expected])
    // Literal pin: catches any silent change of algorithm OR normalization
    expect(hashes[0]).toBe("d8c96945e79adb5f2f4f1112750eaf1e67332eda")
  })

  test("binary vs base64 image data → same hash (payload stripped)", () => {
    const binary: LanguageModelV3Prompt = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "file", data: new Uint8Array([1, 2, 3]), mediaType: "image/png" },
        ],
      } as LanguageModelV3Prompt[number],
    ]
    const base64: LanguageModelV3Prompt = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "file", data: "AQID", mediaType: "image/png" },
        ],
      } as LanguageModelV3Prompt[number],
    ]

    expect(hashPromptMessages(binary)).toEqual(hashPromptMessages(base64))
  })

  test("legacy image parts → payload stripped, identical hashes", () => {
    const a: LanguageModelV3Prompt = [
      {
        role: "user",
        content: [{ type: "image", image: new Uint8Array([9, 9]) }],
      } as unknown as LanguageModelV3Prompt[number],
    ]
    const b: LanguageModelV3Prompt = [
      {
        role: "user",
        content: [{ type: "image", image: "CQk=" }],
      } as unknown as LanguageModelV3Prompt[number],
    ]

    expect(hashPromptMessages(a)).toEqual(hashPromptMessages(b))
  })

  test("system messages are excluded from hashing", () => {
    const withSystem: LanguageModelV3Prompt = [system("v1 dynamic prompt"), user("q")]
    const withOtherSystem: LanguageModelV3Prompt = [system("v2 CHANGED prompt"), user("q")]
    const withoutSystem: LanguageModelV3Prompt = [user("q")]

    expect(hashPromptMessages(withSystem)).toEqual(hashPromptMessages(withOtherSystem))
    expect(hashPromptMessages(withSystem)).toEqual(hashPromptMessages(withoutSystem))
    expect(hashPromptMessages(withSystem)).toHaveLength(1)
  })

  test("tool-call/tool-result hashed by id+name only — args/output ignored", () => {
    const turn = (input: unknown, output: string, toolCallId: string): LanguageModelV3Prompt => [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId, toolName: "bash", input }],
      } as unknown as LanguageModelV3Prompt[number],
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: "bash",
            output: { type: "text", value: output },
          },
        ],
      } as LanguageModelV3Prompt[number],
    ]

    // Same ids, different args + outputs → identical hashes
    expect(hashPromptMessages(turn({ cmd: "ls" }, "out-a", "t1"))).toEqual(
      hashPromptMessages(turn({ cmd: "pwd" }, "out-b", "t1")),
    )

    // Different toolCallId → different hashes
    expect(hashPromptMessages(turn({ cmd: "ls" }, "out-a", "t1"))).not.toEqual(
      hashPromptMessages(turn({ cmd: "ls" }, "out-a", "t2")),
    )
  })
})

describe("intercept end-to-end hash scenarios", () => {
  test("binary→base64 re-serialization of the same image → no reset", () => {
    const prompts = new Map<string, string[]>()
    const headers = { "x-session-affinity": "aff-img" }

    interceptSessionAffinity(
      makeOptions(
        [
          {
            role: "user",
            content: [
              { type: "text", text: "describe" },
              { type: "file", data: new Uint8Array([1, 2, 3]), mediaType: "image/png" },
            ],
          } as LanguageModelV3Prompt[number],
        ],
        { headers, tools: [TOOL] },
      ),
      prompts,
    )

    // Same conversation continues, image now serialized as base64
    const turn2 = makeOptions(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "file", data: "AQID", mediaType: "image/png" },
          ],
        } as LanguageModelV3Prompt[number],
        assistant("a picture of three bytes"),
        user("zoom in"),
      ],
      { headers, tools: [TOOL] },
    )
    const result = interceptSessionAffinity(turn2, prompts)

    expect(result).toBe(turn2)
    expect(result.headers?.["x-session-reset"]).toBeUndefined()
  })

  test("system message change between turns → no reset", () => {
    const prompts = new Map<string, string[]>()
    const headers = { "x-session-affinity": "aff-sys" }

    interceptSessionAffinity(
      makeOptions([system("prompt v1 (with timestamp 12:00)"), user("q1")], {
        headers,
        tools: [TOOL],
      }),
      prompts,
    )

    const turn2 = makeOptions(
      [system("prompt v2 (with timestamp 12:05)"), user("q1"), assistant("a1"), user("q2")],
      { headers, tools: [TOOL] },
    )
    const result = interceptSessionAffinity(turn2, prompts)

    expect(result).toBe(turn2)
    expect(result.headers?.["x-session-reset"]).toBeUndefined()
  })

  test("changed tool args mid-history → no reset; changed toolCallId → reset", () => {
    const mkPrompt = (toolCallId: string, args: unknown): LanguageModelV3Prompt => [
      user("q1"),
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId, toolName: "bash", input: args }],
      } as unknown as LanguageModelV3Prompt[number],
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ],
      } as LanguageModelV3Prompt[number],
      user("q2"),
    ]
    const headers = { "x-session-affinity": "aff-tc" }

    // Seed tracked state (first call has history → reset, expected; ignore)
    const prompts = new Map<string, string[]>()
    interceptSessionAffinity(makeOptions(mkPrompt("t1", { cmd: "ls" }), { headers, tools: [TOOL] }), prompts)

    // Same ids, args serialized differently → NOT diverged
    const sameIds = makeOptions(mkPrompt("t1", { cmd: "ls", extra: true }), { headers, tools: [TOOL] })
    expect(interceptSessionAffinity(sameIds, prompts)).toBe(sameIds)
    expect(sameIds.headers?.["x-session-reset"]).toBeUndefined()

    // Different toolCallId in tracked prefix → diverged → reset
    const changedId = makeOptions(mkPrompt("t2", { cmd: "ls" }), { headers, tools: [TOOL] })
    const result = interceptSessionAffinity(changedId, prompts)
    expect(result.headers?.["x-session-reset"]).toBe("true")
  })
})

describe("diverged — prefix algorithm (core provider.ts:946-952)", () => {
  test("exact equality and strict extension are NOT divergence; truncation and mismatch are", () => {
    expect(diverged(["a", "b"], ["a", "b"])).toBe(false)
    expect(diverged(["a", "b"], ["a", "b", "c"])).toBe(false)
    expect(diverged([], ["a"])).toBe(false)
    expect(diverged(["a", "b"], ["a"])).toBe(true)
    expect(diverged(["a", "b"], ["a", "X", "c"])).toBe(true)
    expect(diverged(["a"], ["X", "b"])).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Model wiring — the pre-step is applied exactly once at the public boundary
// ---------------------------------------------------------------------------

describe("KiroACPLanguageModel — intercept wiring", () => {
  test("doStream applies the pre-step before affinity reading (ephemeral key visible downstream)", async () => {
    const client = createMockClient({
      prompt: mock(async (opts: PromptOptions) => {
        opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "ok" } })
        return { stopReason: "end_turn" }
      }),
    } as unknown as Partial<ACPClient>)
    const affinityPrompts = new Map<string, string[]>()
    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client, affinityPrompts })

    const affinity = uniqueAffinity()
    let capturedAffinityId: string | undefined
    const originalSetAffinityId = model.setAffinityId.bind(model)
    model.setAffinityId = (id: string | undefined) => {
      capturedAffinityId = id
      originalSetAffinityId(id)
    }

    // Toolless call → intercept rewrites the header BEFORE doStreamInner reads it
    const result = await model.doStream(
      makeOptions([user("title please")], {
        headers: { "x-session-affinity": affinity },
        tools: [],
      }),
    )
    await drainStream(result.stream)

    expect(capturedAffinityId).toBe(`${affinity}:ephemeral`)
    expect([...affinityPrompts.keys()]).toEqual([`${affinity}:ephemeral`])
  })

  test("ephemeral child model is NOT re-intercepted (pre-step runs exactly once)", async () => {
    const mainClient = createMockClient()
    const ephemeralClient = createMockClient({
      prompt: mock(async (opts: PromptOptions) => {
        opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "title" } })
        return { stopReason: "end_turn" }
      }),
    } as unknown as Partial<ACPClient>)
    const affinityPrompts = new Map<string, string[]>()
    const model = new KiroACPLanguageModel("claude-sonnet-4.6", {
      client: mainClient,
      getEphemeralClient: () => ephemeralClient,
      affinityPrompts,
    })

    const affinity = uniqueAffinity()
    const result = await model.doStream(
      makeOptions([user("title please")], {
        headers: { "x-session-affinity": affinity },
        tools: [],
      }),
    )
    await drainStream(result.stream)

    // Routed to the isolated ephemeral client — main client untouched
    expect(ephemeralClient.prompt).toHaveBeenCalledTimes(1)
    expect(mainClient.prompt).not.toHaveBeenCalled()

    // Exactly ONE intercept: a double-intercept of the child would have
    // tracked a second `<id>:ephemeral:ephemeral` key
    expect([...affinityPrompts.keys()]).toEqual([`${affinity}:ephemeral`])
  })

  test("doGenerate applies the pre-step (same intercept as doStream)", async () => {
    const client = createMockClient({
      prompt: mock(async (opts: PromptOptions) => {
        opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "generated" } })
        return { stopReason: "end_turn" }
      }),
    } as unknown as Partial<ACPClient>)
    const affinityPrompts = new Map<string, string[]>()
    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client, affinityPrompts })

    const affinity = uniqueAffinity()
    const result = await model.doGenerate(
      makeOptions([user("hello")], {
        headers: { "x-session-affinity": affinity },
        tools: [],
      }),
    )

    expect([...affinityPrompts.keys()]).toEqual([`${affinity}:ephemeral`])
    expect(result.content.some((p) => p.type === "text" && p.text === "generated")).toBe(true)
  })

  test("model without affinityPrompts (direct construction) never intercepts", async () => {
    const client = createMockClient({
      prompt: mock(async (opts: PromptOptions) => {
        opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "ok" } })
        return { stopReason: "end_turn" }
      }),
    } as unknown as Partial<ACPClient>)
    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

    const affinity = uniqueAffinity()
    let capturedAffinityId: string | undefined
    const originalSetAffinityId = model.setAffinityId.bind(model)
    model.setAffinityId = (id: string | undefined) => {
      capturedAffinityId = id
      originalSetAffinityId(id)
    }

    const result = await model.doStream(
      makeOptions([user("hi")], {
        headers: { "x-session-affinity": affinity },
        tools: [],
      }),
    )
    await drainStream(result.stream)

    // No intercept → header NOT rewritten to :ephemeral
    expect(capturedAffinityId).toBe(affinity)
  })
})

// ---------------------------------------------------------------------------
// Provider-level shared state — one affinityPrompts Map per createKiroAcp
// ---------------------------------------------------------------------------

describe("affinity state shared across models of one provider", () => {
  test("model B continues model A's conversation without a reset (shared map)", async () => {
    const promptBodies: string[] = []
    const client = createMockClient({
      prompt: mock(async (opts: PromptOptions) => {
        promptBodies.push((opts.prompt[0] as { text: string }).text)
        opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "resp" } })
        return { stopReason: "end_turn" }
      }),
    } as unknown as Partial<ACPClient>)

    // Two models wired exactly like createKiroAcp wires them: ONE shared map
    const shared = new Map<string, string[]>()
    const modelA = new KiroACPLanguageModel("claude-sonnet-4.6", { client, affinityPrompts: shared })
    const modelB = new KiroACPLanguageModel("claude-opus-4.6", { client, affinityPrompts: shared })

    const affinity = uniqueAffinity()
    const headers = { "x-session-affinity": affinity }

    // Turn 1 on model A — tracks the key
    const r1 = await modelA.doStream(makeOptions([user("u1")], { headers, tools: [] }))
    await drainStream(r1.stream)

    // Turn 2 on model B — prefix continuation of A's tracked state → NO reset.
    // A reset WITH history would have produced the conversation-replay body.
    const r2 = await modelB.doStream(
      makeOptions([user("u1"), assistant("a1"), user("u2")], { headers, tools: [] }),
    )
    await drainStream(r2.stream)

    expect(promptBodies[1]).toBe("u2")
    expect(promptBodies[1]).not.toContain("Resume and act on the following message.")

    // Turn 3 on model B — DIVERGED history (first message rewritten) → reset →
    // full conversation replay sent to a fresh session
    const r3 = await modelB.doStream(
      makeOptions([user("REWRITTEN"), assistant("a1"), user("u3")], { headers, tools: [] }),
    )
    await drainStream(r3.stream)

    expect(promptBodies[2]).toContain("Resume and act on the following message.")
    expect(promptBodies[2]).toContain("<context>")
  })

  test("createKiroAcp injects the SAME map instance into every model it creates", () => {
    const provider = createKiroAcp({ cwd: tmpdir() })

    const modelA = provider.languageModel("claude-sonnet-4.6")
    const modelB = provider("claude-opus-4.6")

    // The map is provider-internal state (core provider.ts:944 keeps it in the
    // loader closure); reference equality across models is the wiring contract.
    const mapA = (modelA as unknown as { config: { affinityPrompts?: Map<string, string[]> } })
      .config.affinityPrompts
    const mapB = (modelB as unknown as { config: { affinityPrompts?: Map<string, string[]> } })
      .config.affinityPrompts

    expect(mapA).toBeInstanceOf(Map)
    expect(mapA).toBe(mapB!)
  })
})
