import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { KiroACPLanguageModel } from "../src/kiro-acp-model"
import { loadPersistedSession } from "../src/session-storage"
import { InstructionDeliveryLedger } from "../src/delivery-ledger"
import { LaneRouter } from "../src/lane-router"
import type { ACPClient, ACPSession, PromptOptions } from "../src/acp-client"
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"

// ---------------------------------------------------------------------------
// Regression tests: two concurrent doStream() calls on ONE model instance
// (two opencode sessions sharing one provider/kiro-cli) must never write or
// read each other's affinity -> kiro session mapping.
// ---------------------------------------------------------------------------

const CWD = "/tmp/affinity-race-test-cwd"

function session(id: string): ACPSession {
  return {
    sessionId: id,
    modes: { currentModeId: "agent", availableModes: [] },
    models: { currentModelId: "claude-sonnet-4.6", availableModels: [] },
  } as ACPSession
}

function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function callOptions(affinity: string, text = "hello"): LanguageModelV3CallOptions {
  return {
    prompt: [{ role: "user", content: [{ type: "text", text }] }],
    headers: { "x-session-affinity": affinity },
  } as unknown as LanguageModelV3CallOptions
}

async function collect(stream: ReadableStream<LanguageModelV3StreamPart>) {
  const parts: LanguageModelV3StreamPart[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return parts
}

function makeClient(overrides: Partial<ACPClient>): ACPClient {
  const ledger = new InstructionDeliveryLedger()
  const laneRouter = new LaneRouter()
  let lock: Promise<void> = Promise.resolve()
  return {
    startedToolless: false,
    withEnsureClientLock: mock(async <T,>(fn: () => Promise<T>): Promise<T> => {
      const prev = lock
      let release!: () => void
      lock = new Promise<void>((r) => {
        release = r
      })
      try {
        await prev
        return await fn()
      } finally {
        release()
      }
    }),
    isRunning: mock(() => false),
    start: mock(() => Promise.resolve({ agentInfo: { name: "kiro-cli", version: "1.0.0" }, agentCapabilities: {} })),
    stop: mock(() => Promise.resolve()),
    loadSession: mock(() => Promise.reject(new Error("no such session"))),
    needsInstructions: mock((id: string, text: string, o?: { highWater?: number }) => ledger.needsInstructions(id, text, o)),
    openInstructionDelivery: mock((id: string, text: string) => ledger.open(id, text)),
    acknowledgeInstructionDelivery: mock(() => {}),
    failInstructionDelivery: mock(() => {}),
    invalidateInstructions: mock(() => {}),
    setModel: mock(() => Promise.resolve()),
    setMode: mock(() => Promise.resolve()),
    executeCommand: mock(() => Promise.resolve({ success: true, message: "ok" })),
    getMetadata: mock(() => undefined),
    getStderr: mock(() => ""),
    getToolsFilePath: mock(() => null),
    getCwd: mock(() => CWD),
    getAgentName: mock(() => undefined),
    getIpcPort: mock(() => null),
    getIpcSecret: mock(() => null),
    getLaneRouter: mock(() => laneRouter),
    setPromptCallback: mock(() => {}),
    waitForToolsReady: mock(() => Promise.resolve()),
    removeSessionToolsFile: mock(() => {}),
    ...overrides,
  } as unknown as ACPClient
}

describe("concurrent sessions keep their own affinity mapping", () => {
  let dataHome: string
  let prevXdg: string | undefined

  beforeEach(() => {
    prevXdg = process.env.XDG_DATA_HOME
    dataHome = mkdtempSync(join(tmpdir(), "kiro-affinity-race-"))
    process.env.XDG_DATA_HOME = dataHome
  })

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prevXdg
    rmSync(dataHome, { recursive: true, force: true })
  })

  test("stream completion persists the mapping under its own affinity, not the latest request's", async () => {
    const gateA = deferred()
    const sessions = [session("kiro-A"), session("kiro-B")]
    let created = 0
    const client = makeClient({
      createSession: mock(() => Promise.resolve(sessions[created++])),
      prompt: mock(async (opts: PromptOptions) => {
        if (opts.sessionId === "kiro-A") await gateA.promise // A finishes last
        opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: `done ${opts.sessionId}` } } as never)
        return { stopReason: "end_turn" }
      }),
    } as unknown as Partial<ACPClient>)
    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

    const a = await model.doStream(callOptions("affinity-A")) // acquires kiro-A, prompt pending
    const b = await model.doStream(callOptions("affinity-B")) // overwrites the shared affinity field
    await collect(b.stream) // B completes first
    gateA.resolve()
    await collect(a.stream) // A's cleanup runs while the field still says "affinity-B"

    expect(loadPersistedSession(CWD, "affinity-A")?.kiroSessionId).toBe("kiro-A")
    expect(loadPersistedSession(CWD, "affinity-B")?.kiroSessionId).toBe("kiro-B")
  })

  test("acquireSession persists a newly created session under the affinity of its own request", async () => {
    const gateA = deferred()
    const sessions = [session("kiro-A"), session("kiro-B")]
    let created = 0
    const client = makeClient({
      // A's session creation is slow; B starts while A is still inside acquireSession().
      createSession: mock(async () => {
        const mine = sessions[created++]
        if (mine.sessionId === "kiro-A") await gateA.promise
        return mine
      }),
      prompt: mock(async (opts: PromptOptions) => {
        opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "ok" } } as never)
        return { stopReason: "end_turn" }
      }),
    } as unknown as Partial<ACPClient>)
    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

    const aP = model.doStream(callOptions("affinity-A")) // blocked inside createSession()
    await new Promise((r) => setTimeout(r, 20))
    const b = await model.doStream(callOptions("affinity-B")) // sets the shared field to "affinity-B"
    await collect(b.stream)
    gateA.resolve()
    const a = await aP
    await collect(a.stream)

    expect(loadPersistedSession(CWD, "affinity-A")?.kiroSessionId).toBe("kiro-A")
    expect(loadPersistedSession(CWD, "affinity-B")?.kiroSessionId).toBe("kiro-B")
  })

  test("a second request loads the persisted session of its own affinity, even if another request started in between", async () => {
    // Seed: affinity-A -> kiro-A, affinity-B -> kiro-B (as left by earlier turns)
    const { persistSession } = await import("../src/session-storage")
    persistSession(CWD, "kiro-A", "affinity-A")
    persistSession(CWD, "kiro-B", "affinity-B")

    const gateLoadA = deferred()
    const loaded: string[] = []
    const client = makeClient({
      loadSession: mock(async (id: string) => {
        if (id === "kiro-A") await gateLoadA.promise // A's load is slow
        loaded.push(id)
        return session(id)
      }),
      prompt: mock(async (opts: PromptOptions) => {
        opts.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "ok" } } as never)
        return { stopReason: "end_turn" }
      }),
    } as unknown as Partial<ACPClient>)
    const model = new KiroACPLanguageModel("claude-sonnet-4.6", { client })

    const aP = model.doStream(callOptions("affinity-A"))
    await new Promise((r) => setTimeout(r, 20))
    const b = await model.doStream(callOptions("affinity-B"))
    await collect(b.stream)
    gateLoadA.resolve()
    const a = await aP
    await collect(a.stream)

    expect(loaded.sort()).toEqual(["kiro-A", "kiro-B"])
    expect(loadPersistedSession(CWD, "affinity-A")?.kiroSessionId).toBe("kiro-A")
    expect(loadPersistedSession(CWD, "affinity-B")?.kiroSessionId).toBe("kiro-B")
  })
})
