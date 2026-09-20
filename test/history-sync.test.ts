import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  planSync,
  buildPromptBlocks,
  createHistorySyncState,
  REPLAY_PREAMBLE,
  sha1,
} from "../src/history-sync"
import { hashPromptMessages } from "../src/session-affinity"
import { getSessionFilePath, loadPersistedSession } from "../src/session-storage"
import { KiroACPLanguageModel } from "../src/kiro-acp-model"
import { LaneRouter } from "../src/lane-router"
import type { ACPClient, ACPSession, ContentBlock, PromptOptions } from "../src/acp-client"
import type { IPCServer, ToolResultRequest } from "../src/ipc-server"
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"

// ---------------------------------------------------------------------------
// Spec 02 acceptance: delta sync between OpenCode's full-history prompt and a
// stateful kiro session. Pure planner/renderer tests first, then model-level
// flows through a mock ACP client.
// ---------------------------------------------------------------------------

function user(text: string): LanguageModelV3Prompt[number] {
  return { role: "user", content: [{ type: "text", text }] }
}

function assistant(text: string): LanguageModelV3Prompt[number] {
  return { role: "assistant", content: [{ type: "text", text }] }
}

function system(text: string): LanguageModelV3Prompt[number] {
  return { role: "system", content: text }
}

function toolCall(id: string, name: string, input: unknown): LanguageModelV3Prompt[number] {
  return { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: name, input: JSON.stringify(input) }] }
}

function toolResult(id: string, name: string, value: string): LanguageModelV3Prompt[number] {
  return {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: id, toolName: name, output: { type: "text", value } }],
  }
}

function hashes(prompt: LanguageModelV3Prompt): string[] {
  return hashPromptMessages(prompt)
}

function roles(prompt: LanguageModelV3Prompt): string[] {
  return prompt.filter((m) => m.role !== "system").map((m) => m.role)
}

function textOf(blocks: ContentBlock[]): string {
  return blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n---\n")
}

// ---------------------------------------------------------------------------
// planSync
// ---------------------------------------------------------------------------

describe("planSync", () => {
  test("first turn, single user message, no prior state → continue from 0", () => {
    const p = [user("A")]
    expect(planSync(undefined, hashes(p), roles(p), false)).toEqual({ mode: "continue", start: 0 })
  })

  test("no prior state but history present → replay", () => {
    const p = [user("A"), assistant("a"), user("B")]
    expect(planSync(undefined, hashes(p), roles(p), false)).toEqual({ mode: "replay", start: 0 })
    expect(planSync([], hashes(p), roles(p), false)).toEqual({ mode: "replay", start: 0 })
  })

  test("extension: skips assistant run kiro produced, delivers from next user", () => {
    const prev = hashes([user("A")])
    const p = [user("A"), assistant("a"), user("B")]
    expect(planSync(prev, hashes(p), roles(p), false)).toEqual({ mode: "continue", start: 2 })
  })

  test("extension: tool call + tool result after prefix are skipped too", () => {
    const prev = hashes([user("A")])
    const p = [user("A"), toolCall("t1", "bash", { c: "ls" }), toolResult("t1", "bash", "ok"), assistant("a"), user("B")]
    expect(planSync(prev, hashes(p), roles(p), false)).toEqual({ mode: "continue", start: 4 })
  })

  test("extension with several trailing user messages delivers all of them", () => {
    const prev = hashes([user("A")])
    const p = [user("A"), assistant("a"), user("B"), user("C")]
    expect(planSync(prev, hashes(p), roles(p), false)).toEqual({ mode: "continue", start: 2 })
  })

  test("divergence (prefix rewritten) → replay", () => {
    const prev = hashes([user("A"), assistant("a")])
    const p = [user("REWRITTEN"), assistant("a"), user("B")]
    expect(planSync(prev, hashes(p), roles(p), false)).toEqual({ mode: "replay", start: 0 })
  })

  test("truncation (prompt shorter than delivered) → replay", () => {
    const prev = hashes([user("A"), assistant("a"), user("B")])
    const p = [user("A")]
    expect(planSync(prev, hashes(p), roles(p), false)).toEqual({ mode: "replay", start: 0 })
  })

  test("identical prompt re-sent (host retry) re-delivers the trailing user run", () => {
    const p = [user("A"), assistant("a"), user("B"), user("C")]
    const prev = hashes(p)
    expect(planSync(prev, hashes(p), roles(p), false)).toEqual({ mode: "continue", start: 2 })
  })

  test("identical prompt ending in assistant → replay (nothing to re-deliver)", () => {
    const p = [user("A"), assistant("a")]
    const prev = hashes(p)
    expect(planSync(prev, hashes(p), roles(p), false)).toEqual({ mode: "replay", start: 0 })
  })

  test("extension where delta is only assistant messages → replay", () => {
    const prev = hashes([user("A")])
    const p = [user("A"), assistant("a")]
    expect(planSync(prev, hashes(p), roles(p), false)).toEqual({ mode: "replay", start: 0 })
  })

  test("forceReset always replays, even on a clean extension", () => {
    const prev = hashes([user("A")])
    const p = [user("A"), assistant("a"), user("B")]
    expect(planSync(prev, hashes(p), roles(p), true)).toEqual({ mode: "replay", start: 0 })
  })
})

// ---------------------------------------------------------------------------
// buildPromptBlocks
// ---------------------------------------------------------------------------

describe("buildPromptBlocks", () => {
  const fresh = { hash: undefined, delivered: false }

  test("continue, first delivery: <system_instructions> merged into the first text block", () => {
    const built = buildPromptBlocks([system("SYS"), user("A")], { mode: "continue", start: 0 }, fresh)
    expect(built.blocks).toHaveLength(1)
    expect(built.blocks[0].text).toBe("<system_instructions>\nSYS\n</system_instructions>\n\nA")
    expect(built.systemHash).toBe(sha1("SYS"))
  })

  test("continue, system already delivered and unchanged: no system wrapper", () => {
    const state = { hash: sha1("SYS"), delivered: true }
    const built = buildPromptBlocks(
      [system("SYS"), user("A"), assistant("a"), user("B")],
      { mode: "continue", start: 2 },
      state,
    )
    expect(built.blocks).toHaveLength(1)
    expect(built.blocks[0].text).toBe("B")
  })

  test("continue, system text changed: <system-update> wrapper", () => {
    const state = { hash: sha1("OLD"), delivered: true }
    const built = buildPromptBlocks(
      [system("NEW"), user("A"), assistant("a"), user("B")],
      { mode: "continue", start: 2 },
      state,
    )
    expect(built.blocks[0].text).toBe("<system-update>\nNEW\n</system-update>\n\nB")
    expect(built.systemHash).toBe(sha1("NEW"))
  })

  test("continue without a system prompt: plain delta, systemHash undefined", () => {
    const built = buildPromptBlocks([user("A"), assistant("a"), user("B")], { mode: "continue", start: 2 }, fresh)
    expect(built.blocks[0].text).toBe("B")
    expect(built.systemHash).toBeUndefined()
  })

  test("replay with a single message: no preamble, no labels", () => {
    const built = buildPromptBlocks([system("SYS"), user("A")], { mode: "replay", start: 0 }, fresh)
    const text = textOf(built.blocks)
    expect(text).not.toContain(REPLAY_PREAMBLE)
    expect(text).toBe("<system_instructions>\nSYS\n</system_instructions>\n\nA")
  })

  test("replay with history: system, then preamble, then labeled history", () => {
    const built = buildPromptBlocks(
      [system("SYS"), user("A"), assistant("a"), user("B")],
      { mode: "replay", start: 0 },
      { hash: sha1("SYS"), delivered: true },
    )
    const text = textOf(built.blocks)
    const iSys = text.indexOf("<system_instructions>")
    const iPre = text.indexOf(REPLAY_PREAMBLE)
    const iA = text.indexOf("[User]\nA")
    const iAsst = text.indexOf("[Assistant]\na")
    const iB = text.indexOf("[User]\nB")
    expect(iSys).toBe(0)
    expect(iPre).toBeGreaterThan(iSys)
    expect(iA).toBeGreaterThan(iPre)
    expect(iAsst).toBeGreaterThan(iA)
    expect(iB).toBeGreaterThan(iAsst)
    // replay always re-sends full instructions, never a <system-update>
    expect(text).not.toContain("<system-update>")
  })

  test("replay includes tool calls and results", () => {
    const built = buildPromptBlocks(
      [user("A"), toolCall("t1", "bash", { command: "ls" }), toolResult("t1", "bash", "file.ts"), assistant("done"), user("B")],
      { mode: "replay", start: 0 },
      fresh,
    )
    const text = textOf(built.blocks)
    expect(text).toContain('[Assistant tool call] bash({"command":"ls"})')
    expect(text).toContain("[Tool result: bash]\nfile.ts")
    expect(text).toContain("[Assistant]\ndone")
  })
})

// ---------------------------------------------------------------------------
// Model-level flows (mock ACP client, directly constructed model → no
// intercept rewrite, so the affinity key stays as given)
// ---------------------------------------------------------------------------

function uniqueAffinity(): string {
  return `hs-${randomBytes(6).toString("hex")}`
}

function makeOptions(
  prompt: LanguageModelV3Prompt,
  affinity: string | undefined,
  extraHeaders: Record<string, string> = {},
): LanguageModelV3CallOptions {
  const headers = affinity ? { "x-session-affinity": affinity, ...extraHeaders } : extraHeaders
  return { prompt, headers, tools: [] } as unknown as LanguageModelV3CallOptions
}

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

interface Harness {
  client: ACPClient
  sent: ContentBlock[][]
  sessionCreates: () => number
  /** Fire a kiro-side `_kiro.dev/clear/status` for a session. */
  invalidate: (sessionId: string) => void
  /** Arm a `_kiro.dev/compaction/status` marker for a session. */
  markCompacted: (sessionId: string, status?: string) => void
}

function createHarness(promptImpl?: (opts: PromptOptions) => Promise<{ stopReason: string }>): Harness {
  const laneRouter = new LaneRouter()
  const sent: ContentBlock[][] = []
  let creates = 0
  let ensureClientLock: Promise<void> = Promise.resolve()
  const invalidationListeners = new Set<(id: string) => void>()
  const compactions = new Map<string, { at: number; status: string }>()
  const session = (): ACPSession => ({
    sessionId: `sess-${++creates}`,
    modes: { currentModeId: "agent", availableModes: [] },
    models: { currentModelId: "claude-sonnet-4.6", availableModels: [] },
  })
  const client = {
    startedToolless: false,
    onSessionInvalidated: mock((cb: (id: string) => void) => {
      invalidationListeners.add(cb)
      return () => invalidationListeners.delete(cb)
    }),
    takeCompaction: mock((id: string) => {
      const c = compactions.get(id)
      compactions.delete(id)
      return c
    }),
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
    start: mock(() => Promise.resolve({ agentInfo: { name: "kiro-cli", version: "1.0.0" }, agentCapabilities: {} })),
    stop: mock(() => Promise.resolve()),
    createSession: mock(() => Promise.resolve(session())),
    createSessionWithToolsPath: mock(() => Promise.resolve(session())),
    loadSession: mock(() => Promise.resolve({} as ACPSession)),
    prompt: mock(async (opts: PromptOptions) => {
      sent.push(opts.prompt)
      if (promptImpl) return promptImpl(opts)
      opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "ok" } })
      return { stopReason: "end_turn" }
    }),
    setModel: mock(() => Promise.resolve()),
    setMode: mock(() => Promise.resolve()),
    getMetadata: mock(() => undefined),
    getStderr: mock(() => ""),
    getToolsFilePath: mock(() => null),
    getCwd: mock(() => tmpdir()),
    getAgentName: mock(() => undefined),
    getIpcPort: mock(() => null),
    getIpcSecret: mock(() => null),
    getIPCServer: mock(() => createMockIPCServer({ getLaneRouter: mock(() => laneRouter) })),
    getLaneRouter: mock(() => laneRouter),
    setPromptCallback: mock(() => {}),
    waitForToolsReady: mock(() => Promise.resolve()),
    getOrCreateToolsFilePath: mock(() => "/tmp/tools.json"),
    createSessionToolsFilePath: mock((id: string) => `/tmp/kiro-acp/tools-test-${id}.json`),
    removeSessionToolsFile: mock(() => {}),
  } as unknown as ACPClient
  return {
    client,
    sent,
    sessionCreates: () => creates,
    invalidate: (id) => {
      for (const cb of invalidationListeners) cb(id)
    },
    markCompacted: (id, status = "completed") => compactions.set(id, { at: Date.now(), status }),
  }
}

async function drain(stream: ReadableStream<LanguageModelV3StreamPart>): Promise<LanguageModelV3StreamPart[]> {
  const reader = stream.getReader()
  const parts: LanguageModelV3StreamPart[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return parts
}

async function turn(model: KiroACPLanguageModel, options: LanguageModelV3CallOptions) {
  const result = await model.doStream(options)
  return drain(result.stream)
}

describe("KiroACPLanguageModel — delta sync", () => {
  test("turn 1 sends system + A; turn 2 sends only B on the same session", async () => {
    const h = createHarness()
    const syncState = createHistorySyncState()
    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client: h.client, syncState })
    const aff = uniqueAffinity()

    await turn(model, makeOptions([system("SYS"), user("A")], aff))
    expect(textOf(h.sent[0])).toBe("<system_instructions>\nSYS\n</system_instructions>\n\nA")

    await turn(model, makeOptions([system("SYS"), user("A"), assistant("a"), user("B")], aff))
    expect(textOf(h.sent[1])).toBe("B")

    expect(h.sessionCreates()).toBe(1)
    expect(syncState.delivered.get(aff)).toEqual(hashes([user("A"), assistant("a"), user("B")]))
  })

  test("changed system prompt on continuation → <system-update> + delta, same session", async () => {
    const h = createHarness()
    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client: h.client })
    const aff = uniqueAffinity()

    await turn(model, makeOptions([system("SYS1"), user("A")], aff))
    await turn(model, makeOptions([system("SYS2"), user("A"), assistant("a"), user("B")], aff))

    expect(textOf(h.sent[1])).toBe("<system-update>\nSYS2\n</system-update>\n\nB")
    expect(h.sessionCreates()).toBe(1)
  })

  test("host-authored <system-update> user message is delivered as part of the labeled delta", async () => {
    const h = createHarness()
    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client: h.client })
    const aff = uniqueAffinity()
    const hostUpdate = "<system-update>\nS\n</system-update>"

    await turn(model, makeOptions([system("SYS"), user("A")], aff))
    await turn(model, makeOptions([system("SYS"), user("A"), assistant("a"), user(hostUpdate), user("B")], aff))

    const text = textOf(h.sent[1])
    expect(text).toContain(`[User]\n${hostUpdate}`)
    expect(text).toContain("[User]\nB")
    expect(text).not.toContain(REPLAY_PREAMBLE)
    expect(h.sessionCreates()).toBe(1)
  })

  test("post-compaction prompt [system, checkpoint, B] → new session, checkpoint replayed verbatim", async () => {
    const h = createHarness()
    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client: h.client })
    const aff = uniqueAffinity()
    const checkpoint = "<conversation-checkpoint>\nsummary of everything\n</conversation-checkpoint>"

    await turn(model, makeOptions([system("SYS"), user("A")], aff))
    await turn(model, makeOptions([system("SYS"), user("A"), assistant("a"), user("B")], aff))
    await turn(model, makeOptions([system("SYS"), user(checkpoint), user("C")], aff))

    expect(h.sessionCreates()).toBe(2)
    const text = textOf(h.sent[2])
    expect(text).toContain("<system_instructions>\nSYS\n</system_instructions>")
    expect(text).toContain(REPLAY_PREAMBLE)
    expect(text).toContain(`[User]\n${checkpoint}`)
    expect(text).toContain("[User]\nC")
    expect(text).not.toContain("[User]\nA")
  })

  test("compaction request (shorter prefix + summarize) → replay with tool calls and results", async () => {
    const h = createHarness()
    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client: h.client })
    const aff = uniqueAffinity()
    const history = [
      user("A"),
      toolCall("t1", "bash", { command: "ls" }),
      toolResult("t1", "bash", "file.ts"),
      assistant("a"),
      user("B"),
      assistant("b"),
    ]

    // Deliver A, then B as normal continuation
    await turn(model, makeOptions([system("SYS"), user("A")], aff))
    await turn(model, makeOptions([system("SYS"), ...history.slice(0, 5)], aff))
    expect(h.sessionCreates()).toBe(1)

    // OpenCode compaction: history prefix stays but the assistant("b") is now
    // followed by a summarize instruction the kiro session never saw. Delivered
    // prefix (A..B) is a strict prefix of this, so it is a CONTINUE with the
    // trailing user message. That is by design: summarize on the live session.
    await turn(model, makeOptions([system("SYS"), ...history, user("Summarize the conversation.")], aff))
    expect(h.sessionCreates()).toBe(1)
    expect(textOf(h.sent[2])).toBe("Summarize the conversation.")

    // Compaction that TRIMS history (drops the tool turn) diverges → replay
    // carries the tool call/result of what remains.
    const trimmed = [user("A"), assistant("a"), user("B"), toolCall("t2", "read", { path: "x" }), toolResult("t2", "read", "content"), assistant("b")]
    await turn(model, makeOptions([system("SYS"), ...trimmed, user("Summarize the conversation.")], aff))
    expect(h.sessionCreates()).toBe(2)
    const text = textOf(h.sent[3])
    expect(text).toContain(REPLAY_PREAMBLE)
    expect(text).toContain('[Assistant tool call] read({"path":"x"})')
    expect(text).toContain("[Tool result: read]\ncontent")
    expect(text).toContain("[User]\nSummarize the conversation.")
  })

  test("x-session-reset forces a replay even on a clean extension", async () => {
    const h = createHarness()
    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client: h.client })
    const aff = uniqueAffinity()

    await turn(model, makeOptions([system("SYS"), user("A")], aff))
    await turn(model, makeOptions([system("SYS"), user("A"), assistant("a"), user("B")], aff, { "x-session-reset": "true" }))

    expect(h.sessionCreates()).toBe(2)
    expect(textOf(h.sent[1])).toContain(REPLAY_PREAMBLE)
    expect(textOf(h.sent[1])).toContain("[User]\nA")
  })

  test("no affinity header: history is replayed, never dropped", async () => {
    const h = createHarness()
    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client: h.client })

    await turn(model, makeOptions([system("SYS"), user("A"), assistant("a"), user("B")], undefined))

    const text = textOf(h.sent[0])
    expect(text).toContain(REPLAY_PREAMBLE)
    expect(text).toContain("[User]\nA")
    expect(text).toContain("[Assistant]\na")
    expect(text).toContain("[User]\nB")
  })

  test("identical prompt re-sent (host retry) re-delivers B without a new session", async () => {
    const h = createHarness()
    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client: h.client })
    const aff = uniqueAffinity()
    const p = [system("SYS"), user("A"), assistant("a"), user("B")]

    await turn(model, makeOptions([system("SYS"), user("A")], aff))
    await turn(model, makeOptions(p, aff))
    await turn(model, makeOptions(p, aff))

    expect(h.sessionCreates()).toBe(1)
    expect(textOf(h.sent[2])).toBe("B")
  })
})

describe("KiroACPLanguageModel — tool-result resume keeps delivered prefix in sync", () => {
  test("resume records the tool-call/tool-result messages; the next turn is a plain continue", async () => {
    const laneRouter = new LaneRouter()
    const resolved: ToolResultRequest[] = []
    let promptResolve: ((v: { stopReason: string }) => void) | null = null
    let calls = 0

    const h = createHarness(async () => {
      calls++
      if (calls === 1) {
        laneRouter.route({ callId: "tc-1", toolName: "bash", args: { command: "ls" } })
        return new Promise<{ stopReason: string }>((resolve) => {
          promptResolve = resolve
        })
      }
      return { stopReason: "end_turn" }
    })
    const ipc = createMockIPCServer({
      getLaneRouter: mock(() => laneRouter),
      resolveToolResult: mock((req: ToolResultRequest) => {
        resolved.push(req)
      }),
    })
    ;(h.client as unknown as { getIPCServer: () => IPCServer }).getIPCServer = mock(() => ipc)
    ;(h.client as unknown as { getLaneRouter: () => LaneRouter }).getLaneRouter = mock(() => laneRouter)

    const syncState = createHistorySyncState()
    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client: h.client, syncState })
    const aff = uniqueAffinity()

    // Turn 1: tool call emitted, stream closes with tool-calls
    const parts1 = await turn(model, makeOptions([system("SYS"), user("list files")], aff))
    expect(parts1.map((p) => p.type)).toContain("tool-call")

    // Turn 2: OpenCode appends assistant tool-call + tool result → resume
    setTimeout(() => promptResolve?.({ stopReason: "end_turn" }), 20)
    const afterTool = [
      system("SYS"),
      user("list files"),
      toolCall("tc-1", "bash", { command: "ls" }),
      toolResult("tc-1", "bash", "file1.ts"),
    ]
    await turn(model, makeOptions(afterTool, aff))

    expect(resolved).toHaveLength(1)
    expect(h.sent).toHaveLength(1)
    expect(syncState.delivered.get(aff)).toEqual(hashes(afterTool))

    // Turn 3: assistant text + new user message → delta of just the user message
    await turn(model, makeOptions([...afterTool, assistant("two files"), user("thanks")], aff))
    expect(h.sent).toHaveLength(2)
    expect(textOf(h.sent[1])).toBe("thanks")
    expect(h.sessionCreates()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Spec 03: delivered prefix persisted to disk; restart continues
// ---------------------------------------------------------------------------

describe("KiroACPLanguageModel — restart continues from persisted prefix", () => {
  let dataDir: string
  let originalXdg: string | undefined

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "hs-xdg-"))
    originalXdg = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = dataDir
  })

  afterEach(() => {
    if (originalXdg !== undefined) process.env.XDG_DATA_HOME = originalXdg
    else delete process.env.XDG_DATA_HOME
    rmSync(dataDir, { recursive: true, force: true })
  })

  const cwd = "/project/restart-sim"

  /** Two turns on instance A; returns the affinity and the prompt A ended with. */
  async function primeInstanceA(aff: string) {
    const h = createHarness()
    ;(h.client as unknown as { getCwd: () => string }).getCwd = mock(() => cwd)
    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client: h.client, syncState: createHistorySyncState() })
    await turn(model, makeOptions([system("SYS"), user("A")], aff))
    await turn(model, makeOptions([system("SYS"), user("A"), assistant("a"), user("B")], aff))
    expect(h.sessionCreates()).toBe(1)
    const persisted = loadPersistedSession(cwd, aff)
    expect(persisted?.kiroSessionId).toBe("sess-1")
    expect(persisted?.delivered).toEqual(hashes([user("A"), assistant("a"), user("B")]))
    expect(persisted?.systemHash).toBe(sha1("SYS"))
  }

  function instanceB(loadSession?: () => Promise<ACPSession>) {
    const h = createHarness()
    ;(h.client as unknown as { getCwd: () => string }).getCwd = mock(() => cwd)
    if (loadSession) {
      ;(h.client as unknown as { loadSession: () => Promise<ACPSession> }).loadSession = mock(loadSession)
    }
    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client: h.client, syncState: createHistorySyncState() })
    return { h, model }
  }

  test("new instance, session/load succeeds → only the third user message is sent", async () => {
    const aff = uniqueAffinity()
    await primeInstanceA(aff)

    const { h, model } = instanceB()
    await turn(model, makeOptions([system("SYS"), user("A"), assistant("a"), user("B"), assistant("b"), user("C")], aff))

    expect(h.sessionCreates()).toBe(0)
    expect(h.client.loadSession).toHaveBeenCalledTimes(1)
    expect(textOf(h.sent[0])).toBe("C")
    expect(loadPersistedSession(cwd, aff)?.delivered).toEqual(
      hashes([user("A"), assistant("a"), user("B"), assistant("b"), user("C")]),
    )
  })

  test("new instance, session/load rejects → one new session, full replay, mapping rewritten", async () => {
    const aff = uniqueAffinity()
    await primeInstanceA(aff)

    const { h, model } = instanceB(() => Promise.reject(new Error("session not found")))
    await turn(model, makeOptions([system("SYS"), user("A"), assistant("a"), user("B"), assistant("b"), user("C")], aff))

    expect(h.sessionCreates()).toBe(1)
    const text = textOf(h.sent[0])
    expect(text).toContain("<system_instructions>\nSYS\n</system_instructions>")
    expect(text).toContain(REPLAY_PREAMBLE)
    expect(text).toContain("[User]\nA")
    expect(text).toContain("[Assistant]\nb")
    expect(text).toContain("[User]\nC")

    const persisted = loadPersistedSession(cwd, aff)
    expect(persisted?.kiroSessionId).toBe("sess-1")
    expect(persisted?.delivered).toEqual(
      hashes([user("A"), assistant("a"), user("B"), assistant("b"), user("C")]),
    )
  })

  test("new instance, history changed while down (2nd message differs) → replay", async () => {
    const aff = uniqueAffinity()
    await primeInstanceA(aff)

    const { h, model } = instanceB()
    await turn(model, makeOptions([system("SYS"), user("A"), assistant("EDITED"), user("B"), assistant("b"), user("C")], aff))

    expect(h.sessionCreates()).toBe(1)
    expect(h.client.loadSession).not.toHaveBeenCalled()
    const text = textOf(h.sent[0])
    expect(text).toContain(REPLAY_PREAMBLE)
    expect(text).toContain("[Assistant]\nEDITED")
  })

  test("legacy persisted file without delivered → replay, no crash", async () => {
    const aff = uniqueAffinity()
    const path = getSessionFilePath(cwd, aff)
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, JSON.stringify({ kiroSessionId: "old-sess", lastUsed: Date.now() }))

    const { h, model } = instanceB()
    await turn(model, makeOptions([system("SYS"), user("A"), assistant("a"), user("B")], aff))

    expect(h.sessionCreates()).toBe(1)
    expect(textOf(h.sent[0])).toContain(REPLAY_PREAMBLE)
    expect(loadPersistedSession(cwd, aff)?.kiroSessionId).toBe("sess-1")
  })

  test("mid-process eviction: CONTINUE plan but kiro created a fresh session → replay", async () => {
    const aff = uniqueAffinity()
    let loads = 0
    const { h, model } = instanceB(() => {
      loads++
      return Promise.reject(new Error("evicted"))
    })

    await turn(model, makeOptions([system("SYS"), user("A")], aff))
    expect(h.sessionCreates()).toBe(1)

    // Same process, sync state says A was delivered; kiro forgot the session.
    await turn(model, makeOptions([system("SYS"), user("A"), assistant("a"), user("B")], aff))

    expect(loads).toBe(1)
    expect(h.sessionCreates()).toBe(2)
    const text = textOf(h.sent[1])
    expect(text).toContain(REPLAY_PREAMBLE)
    expect(text).toContain("[User]\nA")
    expect(text).toContain("[User]\nB")
    expect(loadPersistedSession(cwd, aff)?.kiroSessionId).toBe("sess-2")
  })

  test("persisted file is written with mode 0600", async () => {
    const aff = uniqueAffinity()
    await primeInstanceA(aff)
    const mode = statSync(getSessionFilePath(cwd, aff)).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

// ---------------------------------------------------------------------------
// Spec 04 Part A: KIRO_ACP_DEBUG_FILE dispatch records
// ---------------------------------------------------------------------------

describe("KIRO_ACP_DEBUG_FILE dispatch records", () => {
  let debugFile: string
  let originalDebug: string | undefined

  beforeEach(() => {
    debugFile = join(mkdtempSync(join(tmpdir(), "hs-debug-")), "dispatch.jsonl")
    originalDebug = process.env.KIRO_ACP_DEBUG_FILE
    process.env.KIRO_ACP_DEBUG_FILE = debugFile
  })

  afterEach(() => {
    if (originalDebug !== undefined) process.env.KIRO_ACP_DEBUG_FILE = originalDebug
    else delete process.env.KIRO_ACP_DEBUG_FILE
    rmSync(join(debugFile, ".."), { recursive: true, force: true })
  })

  function records(): Array<Record<string, unknown>> {
    return readFileSync(debugFile, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => "mode" in r && "blocks" in r)
  }

  test("one record per dispatch with mode, newSession and block shapes", async () => {
    const h = createHarness()
    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client: h.client })
    const aff = uniqueAffinity()

    await turn(model, makeOptions([system("SYS"), user("A")], aff))
    await turn(model, makeOptions([system("SYS"), user("A"), assistant("a"), user("B")], aff))
    await turn(model, makeOptions([system("SYS"), user("X".repeat(300)), assistant("a"), user("B")], aff))

    const recs = records()
    expect(recs).toHaveLength(3)

    expect(recs[0]).toMatchObject({ model: "claude-sonnet-4.6", sessionId: "sess-1", mode: "continue", newSession: true })
    expect(recs[1]).toMatchObject({ sessionId: "sess-1", mode: "continue", newSession: false })
    expect(recs[2]).toMatchObject({ sessionId: "sess-2", mode: "replay", newSession: true })

    const blocks = recs[2].blocks as Array<{ type: string; chars: number; head: string }>
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe("text")
    expect(blocks[0].chars).toBeGreaterThan(200)
    expect(blocks[0].head).toHaveLength(200)
    expect(blocks[0].head.startsWith("<system_instructions>")).toBe(true)
    for (const r of recs) expect(typeof r.ts).toBe("string")
  })
})

// ---------------------------------------------------------------------------
// Spec 05: kiro-side compaction and clear signals
// ---------------------------------------------------------------------------

describe("kiro-side session events", () => {
  test("compaction/status marker appears on the next finish of that session only", async () => {
    const h = createHarness()
    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client: h.client })
    const affA = uniqueAffinity()
    const affB = uniqueAffinity()

    // Two live sessions: A on sess-1, B on sess-2
    await turn(model, makeOptions([user("A1")], affA))
    await turn(model, makeOptions([user("B1")], affB))
    h.markCompacted("sess-1")

    const partsB = await turn(model, makeOptions([user("B1"), assistant("ok"), user("B2")], affB))
    const finishB = partsB.find((p) => p.type === "finish")
    expect(finishB?.type === "finish" && finishB.providerMetadata?.kiro).toBeDefined()
    expect((finishB as { providerMetadata?: { kiro?: Record<string, unknown> } }).providerMetadata?.kiro?.compaction).toBeUndefined()

    const partsA = await turn(model, makeOptions([user("A1"), assistant("ok"), user("A2")], affA))
    const finishA = partsA.find((p) => p.type === "finish") as { providerMetadata?: { kiro?: { compaction?: { at: number; status: string } } } }
    expect(finishA.providerMetadata?.kiro?.compaction?.status).toBe("completed")
    expect(typeof finishA.providerMetadata?.kiro?.compaction?.at).toBe("number")

    // Consumed: the following finish carries no marker
    const partsA2 = await turn(model, makeOptions([user("A1"), assistant("ok"), user("A2"), assistant("ok"), user("A3")], affA))
    const finishA2 = partsA2.find((p) => p.type === "finish") as { providerMetadata?: { kiro?: Record<string, unknown> } }
    expect(finishA2.providerMetadata?.kiro?.compaction).toBeUndefined()
    expect(h.sessionCreates()).toBe(2)
  })

  test("clear/status invalidates the affinity bound to that session → next turn replays", async () => {
    const h = createHarness()
    const syncState = createHistorySyncState()
    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client: h.client, syncState })
    const aff = uniqueAffinity()

    await turn(model, makeOptions([system("SYS"), user("A")], aff))
    await turn(model, makeOptions([system("SYS"), user("A"), assistant("a"), user("B")], aff))
    expect(h.sessionCreates()).toBe(1)
    expect(syncState.sessions.get(aff)).toBe("sess-1")

    h.invalidate("sess-1")
    expect(syncState.delivered.has(aff)).toBe(false)

    await turn(model, makeOptions([system("SYS"), user("A"), assistant("a"), user("B"), assistant("b"), user("C")], aff))
    expect(h.sessionCreates()).toBe(2)
    const text = textOf(h.sent[2])
    expect(text).toContain(REPLAY_PREAMBLE)
    expect(text).toContain("[User]\nA")
    expect(text).toContain("[User]\nC")
    expect(syncState.sessions.get(aff)).toBe("sess-2")
  })

  test("clear/status for an unrelated session leaves the affinity alone", async () => {
    const h = createHarness()
    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client: h.client })
    const aff = uniqueAffinity()

    await turn(model, makeOptions([system("SYS"), user("A")], aff))
    h.invalidate("sess-other")
    await turn(model, makeOptions([system("SYS"), user("A"), assistant("a"), user("B")], aff))

    expect(h.sessionCreates()).toBe(1)
    expect(textOf(h.sent[1])).toBe("B")
  })
})
