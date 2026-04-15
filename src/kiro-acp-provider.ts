import type { LanguageModelV3 } from "@ai-sdk/provider"
import { ACPClient, type ACPClientOptions, type PermissionRequest, type PermissionDecision } from "./acp-client"
import { KiroACPLanguageModel } from "./kiro-acp-model"

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
  /** Custom permission handler for tool call approvals. */
  onPermission?: (request: PermissionRequest) => PermissionDecision
  /** Extra environment variables for the kiro-cli subprocess. */
  env?: Record<string, string>
  /** Client info sent during the ACP initialize handshake. */
  clientInfo?: { name: string; version: string; title?: string }
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
    onPermission: settings.onPermission,
    env: settings.env,
    clientInfo: settings.clientInfo,
  }

  // Create the ACP client lazily — it will be started on first model use
  const client = new ACPClient(clientOptions)

  const createModel = (modelId: string): LanguageModelV3 => {
    return new KiroACPLanguageModel(modelId, {
      client,
    })
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

  return provider
}
