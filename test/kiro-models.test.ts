import { afterEach, describe, expect, spyOn, test } from "bun:test"
import {
  ACPClient,
  type ACPSession,
  type CommandResult,
  type EffortOptionsResult,
  type InitializeResult,
} from "../src/acp-client"
import { listModels } from "../src/kiro-models"

const installedSpies: Array<{ mockRestore(): void }> = []

function track<T extends { mockRestore(): void }>(spy: T): T {
  installedSpies.push(spy)
  return spy
}

function runtimeSession(
  modelIds: readonly string[],
  currentModelId = modelIds[0]!,
): ACPSession {
  return {
    sessionId: "runtime-session",
    modes: { currentModeId: "code", availableModes: [] },
    models: {
      currentModelId,
      availableModels: modelIds.map((modelId) => ({
        modelId,
        name: `Name for ${modelId}`,
      })),
    },
  }
}

function installLifecycle(session: ACPSession, events: string[]): void {
  track(spyOn(ACPClient.prototype, "start")).mockImplementation(async () => {
    events.push("start")
    return {
      agentInfo: { name: "kiro-cli", version: "test" },
      agentCapabilities: {},
    } satisfies InitializeResult
  })
  track(spyOn(ACPClient.prototype, "createSession")).mockImplementation(async () => {
    events.push("session")
    return session
  })
  track(spyOn(ACPClient.prototype, "stop")).mockImplementation(async () => {
    events.push("stop")
  })
}

afterEach(() => {
  for (const installedSpy of installedSpies.splice(0).reverse()) {
    installedSpy.mockRestore()
  }
})

describe("listModels", () => {
  test("preserves exact runtime IDs and discovers opaque efforts serially", async () => {
    const ids = ["Runtime/Alpha.v2", " runtime-beta ", "Runtime/Empty"] as const
    const events: string[] = []
    const session = runtimeSession(ids, ids[0])
    let selectedModel = session.models.currentModelId
    installLifecycle(session, events)

    track(spyOn(ACPClient.prototype, "executeCommand")).mockImplementation(
      async (_sessionId, command, args): Promise<CommandResult> => {
        selectedModel = args.value as string
        events.push(`${command}:${selectedModel}`)
        return { success: true, message: "selected" }
      },
    )
    track(spyOn(ACPClient.prototype, "requestEffortOptions")).mockImplementation(
      async (): Promise<EffortOptionsResult> => {
        events.push(`options:${selectedModel}`)
        if (selectedModel === ids[0]) {
          return {
            runtimeEfforts: ["balanced-plus", "MAX.v2"],
            baselineEffort: "balanced-plus",
          }
        }
        if (selectedModel === ids[1]) {
          return {
            runtimeEfforts: ["Future/Burst!"],
            baselineEffort: "Future/Burst!",
          }
        }
        return { runtimeEfforts: [] }
      },
    )
    track(spyOn(ACPClient.prototype, "setModel")).mockImplementation(
      async (_sessionId, modelId) => {
        events.push(`restore:${modelId}`)
      },
    )

    const models = await listModels({ cwd: "/runtime-catalog" })

    expect(models.map((model) => model.modelId)).toEqual(ids)
    expect(models.map(({ runtimeEfforts, baselineEffort }) => ({
      runtimeEfforts,
      baselineEffort,
    }))).toEqual([
      {
        runtimeEfforts: ["balanced-plus", "MAX.v2"],
        baselineEffort: "balanced-plus",
      },
      {
        runtimeEfforts: ["Future/Burst!"],
        baselineEffort: "Future/Burst!",
      },
      {
        runtimeEfforts: [],
        baselineEffort: undefined,
      },
    ])
    expect(Object.hasOwn(models[2]!, "runtimeEfforts")).toBe(true)
    expect(Object.hasOwn(models[2]!, "baselineEffort")).toBe(false)
    expect(events).toEqual([
      "start",
      "session",
      `model:${ids[0]}`,
      `options:${ids[0]}`,
      `model:${ids[1]}`,
      `options:${ids[1]}`,
      `model:${ids[2]}`,
      `options:${ids[2]}`,
      `restore:${ids[0]}`,
      "stop",
    ])
  })

  test("returns required empty efforts when options are unavailable", async () => {
    const ids = [
      "Runtime/Unsupported",
      "Runtime/Unavailable",
      "Runtime/Failed",
    ] as const
    const events: string[] = []
    const session = runtimeSession(ids)
    let selectedModel = session.models.currentModelId
    installLifecycle(session, events)

    track(spyOn(ACPClient.prototype, "executeCommand")).mockImplementation(
      async (_sessionId, _command, args): Promise<CommandResult> => {
        selectedModel = args.value as string
        events.push(`switch:${selectedModel}`)
        return selectedModel === ids[0]
          ? { success: false, message: "unsupported" }
          : { success: true, message: "selected" }
      },
    )
    track(spyOn(ACPClient.prototype, "requestEffortOptions")).mockImplementation(
      async (): Promise<EffortOptionsResult | undefined> => {
        events.push(`options:${selectedModel}`)
        if (selectedModel === ids[1]) return undefined
        throw new Error("options unavailable")
      },
    )
    track(spyOn(ACPClient.prototype, "setModel")).mockImplementation(
      async (_sessionId, modelId) => {
        events.push(`restore:${modelId}`)
        throw new Error("restoration unavailable")
      },
    )

    const models = await listModels({ cwd: "/fallback-catalog" })

    expect(models.map(({ modelId, runtimeEfforts, baselineEffort }) => ({
      modelId,
      runtimeEfforts,
      baselineEffort,
    }))).toEqual([
      {
        modelId: ids[0],
        runtimeEfforts: [],
        baselineEffort: undefined,
      },
      {
        modelId: ids[1],
        runtimeEfforts: [],
        baselineEffort: undefined,
      },
      {
        modelId: ids[2],
        runtimeEfforts: [],
        baselineEffort: undefined,
      },
    ])
    expect(models.every((model) => Object.hasOwn(model, "runtimeEfforts"))).toBe(true)
    expect(events).toEqual([
      "start",
      "session",
      `switch:${ids[0]}`,
      `switch:${ids[1]}`,
      `options:${ids[1]}`,
      `switch:${ids[2]}`,
      `options:${ids[2]}`,
      `restore:${ids[0]}`,
      "stop",
    ])
  })

  test("removes spoofed raw effort observations before applying validated discovery", async () => {
    const ids = [
      "Runtime/Switch-Failed",
      "Runtime/Options-Unavailable",
      "Runtime/Observed",
    ] as const
    const events: string[] = []
    const session = runtimeSession(ids)
    session.models.availableModels = ids.map((modelId) => ({
      modelId,
      name: `Name for ${modelId}`,
      description: `Description for ${modelId}`,
      transportMetadata: { preserved: modelId },
      runtimeEfforts: ["spoofed"],
      baselineEffort: "spoofed",
    }))
    let selectedModel = session.models.currentModelId
    installLifecycle(session, events)

    track(spyOn(ACPClient.prototype, "executeCommand")).mockImplementation(
      async (_sessionId, _command, args): Promise<CommandResult> => {
        selectedModel = args.value as string
        if (selectedModel === ids[0]) throw new Error("switch unavailable")
        return { success: true, message: "selected" }
      },
    )
    track(spyOn(ACPClient.prototype, "requestEffortOptions")).mockImplementation(
      async (): Promise<EffortOptionsResult | undefined> => {
        if (selectedModel === ids[1]) return undefined
        return {
          runtimeEfforts: ["observed/Future.v2"],
          baselineEffort: "not-observed",
        }
      },
    )
    track(spyOn(ACPClient.prototype, "setModel")).mockImplementation(async () => {})

    const models = await listModels({ cwd: "/spoofed-catalog" })

    expect(models.slice(0, 2).map((model) => model.runtimeEfforts)).toEqual([[], []])
    expect(models.every((model) => Object.hasOwn(model, "runtimeEfforts"))).toBe(true)
    expect(models.slice(0, 2).every((model) => !Object.hasOwn(model, "baselineEffort"))).toBe(
      true,
    )
    expect(models[2]?.runtimeEfforts).toEqual(["observed/Future.v2"])
    expect(Object.hasOwn(models[2]!, "baselineEffort")).toBe(false)
    expect(models).toMatchObject(
      ids.map((modelId) => ({
        description: `Description for ${modelId}`,
        transportMetadata: { preserved: modelId },
      })),
    )
  })

  test("stops in finally when discovery fails before a model can be restored", async () => {
    const events: string[] = []
    track(spyOn(ACPClient.prototype, "start")).mockImplementation(async () => {
      events.push("start")
      return {
        agentInfo: { name: "kiro-cli", version: "test" },
        agentCapabilities: {},
      }
    })
    track(spyOn(ACPClient.prototype, "createSession")).mockImplementation(async () => {
      events.push("session-failed")
      throw new Error("session unavailable")
    })
    track(spyOn(ACPClient.prototype, "stop")).mockImplementation(async () => {
      events.push("stop")
    })
    const restore = track(spyOn(ACPClient.prototype, "setModel"))

    await expect(listModels({ cwd: "/failed-catalog" })).rejects.toThrow(
      "session unavailable",
    )
    expect(restore).not.toHaveBeenCalled()
    expect(events).toEqual(["start", "session-failed", "stop"])
  })
})
