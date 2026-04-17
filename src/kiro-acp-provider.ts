import type { LanguageModelV3 } from "@ai-sdk/provider"
import { ACPClient, type ACPClientOptions, type PermissionRequest, type PermissionDecision } from "./acp-client"
import { KiroACPLanguageModel } from "./kiro-acp-model"

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
  /** Max context window in tokens. Default: 1_000_000. */
  contextWindow?: number
}

export interface KiroACPModelOverrides {
  contextWindow?: number
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
  }

  const client = new ACPClient(clientOptions)
  let lastModel: KiroACPLanguageModel | null = null

  const createModel = (modelId: string, overrides?: KiroACPModelOverrides): LanguageModelV3 => {
    const model = new KiroACPLanguageModel(modelId, {
      client,
      sessionId: settings.sessionId,
      contextWindow: overrides?.contextWindow ?? settings.contextWindow,
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
