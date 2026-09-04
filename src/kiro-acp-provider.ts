import type { LanguageModelV3 } from "@ai-sdk/provider"
import { ACPClient, type ACPClientOptions, type PermissionRequest, type PermissionDecision } from "./acp-client"
import { KiroACPLanguageModel, type KiroACPStallSettings } from "./kiro-acp-model"
import type { KiroEffort } from "./kiro-effort"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KiroACPProviderSettings {
  cwd?: string
  model?: string
  agent?: string
  trustAllTools?: boolean
  agentPrompt?: string
  onPermission?: (request: PermissionRequest) => PermissionDecision
  env?: Record<string, string>
  clientInfo?: { name: string; version: string; title?: string }
  sessionId?: string
  /**
   * Max context window in tokens, applied to every model from this provider.
   * Used when no per-call `contextWindow` override and no matching
   * `contextWindows[modelId]` entry is given. Falls back to 1_000_000.
   */
  contextWindow?: number
  /** Per-model context windows keyed by model id, e.g. relayed from a host's model catalog (models.dev). Used when no per-call `contextWindow` override is given. */
  contextWindows?: Record<string, number>
  /** Explicit reasoning effort for every model from this provider. */
  effort?: KiroEffort
  /** Explicit per-model efforts keyed by model id. */
  efforts?: Record<string, KiroEffort>
  /** MCP tool call timeout in minutes. Default: 30. */
  mcpTimeout?: number
  /**
   * Stall watchdog: how long kiro-cli may stay silent during a turn before
   * the turn counts as stalled, and whether to narrate the stall live.
   *
   * - `afterMs` (default `10_000`): silence threshold in ms; `0` disables
   *   the watchdog entirely.
   * - `live` (default `"reasoning"`): `"reasoning"` streams a reasoning
   *   fragment while the turn is stalled (`Kiro: no output for 10s - ...`,
   *   refreshed every `afterMs`, closed with `output resumed after Ns`);
   *   `"off"` streams nothing.
   *
   * Whenever a turn stalled, its final `text-end`/`reasoning-end` carries
   * `providerMetadata.kiro.status = { stalledMs, hint? }` next to the
   * credits; `hint` is the newest ERROR line kiro-cli wrote to its own
   * chat log during the turn, when readable.
   *
   * @since 3.2.0
   */
  stall?: KiroACPStallSettings
}

export interface KiroACPModelOverrides {
  contextWindow?: number
  /** Explicit model effort. Overrides the provider-level `effort`/`efforts` settings. */
  effort?: KiroEffort
}

export interface KiroACPProvider {
  (modelId: string, overrides?: KiroACPModelOverrides): LanguageModelV3
  languageModel(modelId: string, overrides?: KiroACPModelOverrides): LanguageModelV3
  shutdown(): Promise<void>
  getClient(): ACPClient
  getSessionId(): string | null
  injectContext(summary: string): Promise<void>
  getTotalCredits(): number
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

/**
 * Create a KiroACP provider backed by a single kiro-cli process.
 *
 * ```ts
 * const kiro = createKiroAcp({ cwd: "/path/to/project" })
 * const model = kiro("claude-sonnet-4.6")
 * const result = await generateText({ model, prompt: "Hello!" })
 * await kiro.shutdown()
 * ```
 */
export function createKiroAcp(settings: KiroACPProviderSettings = {}): KiroACPProvider {
  const clientOptions: ACPClientOptions = {
    cwd: settings.cwd ?? process.cwd(),
    agent: settings.agent,
    trustAllTools: settings.trustAllTools,
    agentPrompt: settings.agentPrompt,
    onPermission: settings.onPermission,
    env: settings.env,
    clientInfo: settings.clientInfo,
    mcpTimeout: settings.mcpTimeout,
  }

  const client = new ACPClient(clientOptions)

  // Lazy-init isolated ACPClient for ephemeral (toolless) flows — e.g.
  // toolless title-generation calls (from a host like opencode). Created on
  // first toolless doStream so projects that never use toolless flows pay no
  // extra process cost. Stopped from provider.shutdown() if it was created.
  let ephemeralClient: ACPClient | null = null
  const getEphemeralClient = (): ACPClient => {
    if (!ephemeralClient) {
      ephemeralClient = new ACPClient(clientOptions)
    }
    return ephemeralClient
  }

  let lastModel: KiroACPLanguageModel | null = null

  // Session-affinity intercept state (tracked message hashes per affinity
  // key), shared by ALL models created from this provider instance so
  // cross-model continuation within one session is detected correctly —
  // one shared map per provider, never per model.
  const affinityPrompts = new Map<string, string[]>()

  const createModel = (modelId: string, overrides?: KiroACPModelOverrides): LanguageModelV3 => {
    const model = new KiroACPLanguageModel(modelId, {
      client,
      sessionId: settings.sessionId,
      // Resolution order: explicit per-call override → per-model relay map
      // (e.g. host catalog from models.dev) → provider-level setting → 1M
      // flat fallback for unknown model ids.
      contextWindow:
        overrides?.contextWindow ??
        settings.contextWindows?.[modelId] ??
        settings.contextWindow ??
        1_000_000,
      // Explicit effort precedence: model override -> per-model setting -> provider.
      effort:
        overrides?.effort ??
        settings.efforts?.[modelId] ??
        settings.effort,
      stall: settings.stall,
      getEphemeralClient,
      affinityPrompts,
    })
    lastModel = model
    return model
  }

  const provider = ((modelId: string, overrides?: KiroACPModelOverrides): LanguageModelV3 => {
    return createModel(modelId, overrides)
  }) as KiroACPProvider

  provider.languageModel = createModel

  provider.shutdown = async (): Promise<void> => {
    await client.stop()
    if (ephemeralClient) {
      await ephemeralClient.stop()
    }
  }

  provider.getClient = (): ACPClient => {
    return client
  }

  provider.getSessionId = (): string | null => {
    return lastModel?.getSessionId() ?? null
  }

  provider.injectContext = async (summary: string): Promise<void> => {
    if (!lastModel) {
      throw new Error("No model instance created yet. Call provider(modelId) first.")
    }
    await lastModel.injectContext(summary)
  }

  provider.getTotalCredits = (): number => {
    return lastModel?.getTotalCredits() ?? 0
  }

  return provider
}
