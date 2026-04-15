import type { LanguageModelV3 } from "@ai-sdk/provider"
import { ACPClient, type ACPClientOptions, type PermissionRequest, type PermissionDecision } from "./acp-client"
import { KiroACPLanguageModel } from "./kiro-acp-model"
import type { ToolExecutorFn } from "./ipc-server"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Settings for creating a KiroACP provider. */
export interface KiroACPProviderSettings {
  /** Working directory for kiro-cli. Defaults to process.cwd(). */
  cwd?: string
  /** Default model ID to use when none is specified. */
  model?: string
  /** Custom agent name passed via --agent flag (e.g. "opencode"). */
  agent?: string
  /** Pass --trust-all-tools to kiro-cli. */
  trustAllTools?: boolean
  /** Custom system prompt for the agent config. Overrides the default prompt. */
  agentPrompt?: string
  /** Custom permission handler for tool call approvals. */
  onPermission?: (request: PermissionRequest) => PermissionDecision
  /** Extra environment variables for the kiro-cli subprocess. */
  env?: Record<string, string>
  /** Client info sent during the ACP initialize handshake. */
  clientInfo?: { name: string; version: string; title?: string }
  /** Resume an existing ACP session instead of creating new. */
  sessionId?: string
  /** Model's max context window in tokens (from models.dev). Default: 1_000_000. */
  contextWindow?: number
  /** Tool executor for delegated tool calls from the MCP bridge. */
  toolExecutor?: ToolExecutorFn
}

/** The KiroACP provider interface. */
export interface KiroACPProvider {
  /** Create a language model for the given model ID. */
  (modelId: string): LanguageModelV3
  /** Create a language model for the given model ID. */
  languageModel(modelId: string): LanguageModelV3

  /** Gracefully shut down the kiro-cli process. */
  shutdown(): Promise<void>
  /** Get the underlying ACP client (for advanced usage). */
  getClient(): ACPClient
  /** Get the current ACP session ID for persistence. */
  getSessionId(): string | null
  /** Inject context summary for session rehydration. */
  injectContext(summary: string): Promise<void>
  /** Get total credits consumed across all turns in this session. */
  getTotalCredits(): number
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

/**
 * Create a KiroACP provider that manages a single kiro-cli process
 * and creates LanguageModelV3 instances backed by ACP.
 *
 * Usage:
 * ```ts
 * import { createKiroAcp } from "kiro-acp-ai-provider"
 *
 * const kiro = createKiroAcp({ cwd: "/path/to/project" })
 * const model = kiro("claude-sonnet-4-20250514")
 *
 * // Use with AI SDK
 * const result = await generateText({ model, prompt: "Hello!" })
 *
 * // Clean up when done
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
    toolExecutor: settings.toolExecutor,
  }

  // Create the ACP client lazily — it will be started on first model use
  const client = new ACPClient(clientOptions)

  // Track the most recently created model instance for session access.
  // Since all models share the same client and session, any instance can
  // provide the session ID and inject context.
  let lastModel: KiroACPLanguageModel | null = null

  const createModel = (modelId: string): LanguageModelV3 => {
    const model = new KiroACPLanguageModel(modelId, {
      client,
      sessionId: settings.sessionId,
      contextWindow: settings.contextWindow,
    })
    lastModel = model
    return model
  }

  // The provider function itself creates a model
  const provider = ((modelId: string): LanguageModelV3 => {
    return createModel(modelId)
  }) as KiroACPProvider

  // Attach methods
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
