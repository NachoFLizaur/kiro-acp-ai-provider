import { describe, test, expect } from "bun:test"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { createKiroAcp, type KiroACPModelOverrides } from "../src/kiro-acp-provider"
import type { ACPClient } from "../src/acp-client"
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"

// ---------------------------------------------------------------------------
// contextWindow resolution chain.
//
// Resolution order (kiro-acp-provider.ts): explicit per-call
// `overrides.contextWindow` → per-model `settings.contextWindows[modelId]`
// (the host catalog relay, e.g. models.dev windows forwarded by a plugin) →
// provider-level `settings.contextWindow` → 1_000_000 flat fallback.
//
// There is NO built-in per-model table anymore: per-model windows are
// supplied by the host. With no relay map and no override, every model id
// resolves to the provider-level setting or, failing that, 1M.
//
// The resolved window is observed BEHAVIORALLY through the public stream:
// with `contextUsagePercentage: 1` and zero streamed output, the finish
// event's `usage.inputTokens.total` equals `round(1% × contextWindow)`.
// The provider's real ACPClient instance has its process-touching methods
// stubbed (public surface via `provider.getClient()`) so no kiro-cli spawns.
// ---------------------------------------------------------------------------

const TOOL = {
  type: "function",
  name: "echo",
  description: "echo a value",
  inputSchema: { type: "object", properties: {} },
} as const

/**
 * Stub every process-touching method on the provider's REAL ACPClient
 * instance so a tooled doStream completes without spawning kiro-cli.
 * Only public methods are replaced; everything else runs the real code
 * (tools-file writing/validation, lane-router lookup, cleanup).
 */
function patchClientForStream(client: ACPClient, modelId: string): void {
  client.start = (async () => ({
    agentInfo: { name: "stub", version: "0.0.0" },
    agentCapabilities: {},
  })) as ACPClient["start"]
  client.createSessionWithToolsPath = (async () => ({
    sessionId: `sess-${randomBytes(4).toString("hex")}`,
    modes: { currentModeId: "agent", availableModes: [] },
    models: { currentModelId: modelId, availableModels: [] },
  })) as ACPClient["createSessionWithToolsPath"]
  client.prompt = (async () => ({ stopReason: "end_turn" })) as ACPClient["prompt"]
  client.getMetadata = ((sessionId: string) => ({
    sessionId,
    contextUsagePercentage: 1,
  })) as ACPClient["getMetadata"]
}

/**
 * Resolve a model through the provider, run one (tooled, stubbed) stream and
 * return `usage.inputTokens.total` from the finish event — equal to
 * `round(1% × resolved contextWindow)` because no output text streams.
 */
async function observedWindowTokens(
  settings: { contextWindow?: number; contextWindows?: Record<string, number> },
  modelId: string,
  overrides?: KiroACPModelOverrides,
): Promise<number | undefined> {
  const provider = createKiroAcp({ cwd: tmpdir(), ...settings })
  patchClientForStream(provider.getClient(), modelId)

  const model = provider.languageModel(modelId, overrides)
  const result = await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [TOOL],
  } as LanguageModelV3CallOptions)

  const reader = result.stream.getReader()
  let finish: LanguageModelV3StreamPart | undefined
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value.type === "finish") finish = value
  }

  return finish?.type === "finish" ? finish.usage.inputTokens.total : undefined
}

describe("contextWindow resolution: override > contextWindows[id] > contextWindow > 1M", () => {
  test("explicit per-call override wins over the relay map and provider settings", async () => {
    const tokens = await observedWindowTokens(
      {
        contextWindow: 500_000,
        contextWindows: { "claude-sonnet-4.5": 200_000 },
      },
      "claude-sonnet-4.5",
      { contextWindow: 40_000 },
    )
    // 1% of 40_000 — not 2_000 (relay map) nor 5_000 (provider setting)
    expect(tokens).toBe(400)
  })

  test("relay map (contextWindows[modelId]) wins over provider-level setting", async () => {
    const tokens = await observedWindowTokens(
      {
        contextWindow: 500_000,
        contextWindows: { "claude-sonnet-4.5": 200_000 },
      },
      "claude-sonnet-4.5",
    )
    // 1% of 200_000 (relay map) — not 5_000 (the provider-level 500k setting)
    expect(tokens).toBe(2_000)
  })

  test("provider-level setting used when no relay entry matches the model id", async () => {
    const tokens = await observedWindowTokens(
      {
        contextWindow: 500_000,
        contextWindows: { "some-other-model": 200_000 },
      },
      "claude-sonnet-4.5",
    )
    // 1% of 500_000 — the relay map has no entry for this id
    expect(tokens).toBe(5_000)
  })

  test("flat 1M fallback when neither override, relay map, nor setting applies", async () => {
    const tokens = await observedWindowTokens({}, "model-that-does-not-exist")
    expect(tokens).toBe(10_000) // 1% of the 1M fallback
  })
})

describe("contextWindows relay map: per-model resolution + unknown-id fallback", () => {
  const relay = {
    "claude-sonnet-4.5": 200_000,
    "claude-opus-4.6": 1_000_000,
    "deepseek-3.2": 164_000,
  }

  test("each known model id resolves to its own relayed window", async () => {
    expect(await observedWindowTokens({ contextWindows: relay }, "claude-sonnet-4.5")).toBe(2_000)
    expect(await observedWindowTokens({ contextWindows: relay }, "claude-opus-4.6")).toBe(10_000)
    expect(await observedWindowTokens({ contextWindows: relay }, "deepseek-3.2")).toBe(1_640)
  })

  test("an id absent from the relay map falls back to 1M", async () => {
    const tokens = await observedWindowTokens({ contextWindows: relay }, "qwen3-coder-next")
    expect(tokens).toBe(10_000) // 1% of the 1M fallback — not in the relay map
  })
})
