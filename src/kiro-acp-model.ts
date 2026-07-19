import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3FunctionTool,
  LanguageModelV3GenerateResult,
  LanguageModelV3ProviderTool,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
  LanguageModelV3Prompt,
  SharedV3ProviderMetadata,
} from "@ai-sdk/provider"
import { appendFileSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs"
import { createHash, randomBytes } from "node:crypto"
import {
  KiroACPConnectionError,
  KiroACPError,
  type ACPClient,
  type ACPSession,
  type SessionUpdate,
  type ContentBlock,
  type SessionMetadata,
} from "./acp-client"
import { reasoningEffortsFor, defaultEffortFor } from "./kiro-effort"
import { verifyAuth } from "./kiro-auth"
import { persistSession, loadPersistedSession, clearPersistedSession } from "./session-storage"
import { interceptSessionAffinity } from "./session-affinity"
import type { MCPToolDefinition, MCPToolsFile } from "./mcp-bridge-tools"
import type { IPCContentBlock, PendingToolCall } from "./ipc-server"
import type { LaneRouter } from "./lane-router"

const TOOL_READY_TIMEOUT_MS = 5000
const KIRO_TOOL_NAME_MAX_LENGTH = 48

type ToolNameMapping = {
  originalToKiro: Map<string, string>
  kiroToOriginal: Map<string, string>
}

function normalizeKiroToolName(name: string): string {
  let normalized = name.replace(/[^a-zA-Z0-9_]/g, "_")
  if (normalized.length === 0) normalized = "tool"
  else if (!/^[a-zA-Z]/.test(normalized)) normalized = `tool_${normalized}`
  return normalized
}

function kiroToolNameBase(name: string): string {
  return normalizeKiroToolName(name).slice(0, KIRO_TOOL_NAME_MAX_LENGTH)
}

function kiroToolNameWithHash(base: string, original: string): string {
  const suffix = createHash("sha256").update(original).digest("hex").slice(0, 10)
  const prefixLength = KIRO_TOOL_NAME_MAX_LENGTH - suffix.length - 1
  return `${base.slice(0, prefixLength)}_${suffix}`
}

/**
 * Kiro rejects MCP tool names outside `^[a-zA-Z][a-zA-Z0-9_]*$` and names
 * whose server-qualified form exceeds 64 characters. OpenCode tool IDs may
 * contain dashes, so expose compact Kiro-safe aliases and map calls back to
 * the original host IDs at the provider boundary.
 */
function buildToolNameMapping(names: string[]): ToolNameMapping {
  const sortedNames = [...new Set(names)].sort()
  const bases = new Map(sortedNames.map((name) => [name, kiroToolNameBase(name)]))
  const baseCounts = new Map<string, number>()
  for (const base of bases.values()) baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1)

  const originalToKiro = new Map<string, string>()
  const kiroToOriginal = new Map<string, string>()
  for (const name of sortedNames) {
    const base = bases.get(name)!
    const truncated = normalizeKiroToolName(name).length > KIRO_TOOL_NAME_MAX_LENGTH
    const mapped = truncated || (baseCounts.get(base) ?? 0) > 1
      ? kiroToolNameWithHash(base, name)
      : base
    originalToKiro.set(name, mapped)
    kiroToOriginal.set(mapped, name)
  }
  return { originalToKiro, kiroToOriginal }
}

function functionToolDefinitions(
  tools: Array<LanguageModelV3FunctionTool | LanguageModelV3ProviderTool> | undefined,
): Array<Pick<LanguageModelV3FunctionTool, "name" | "description" | "inputSchema">> {
  return (tools ?? [])
    .filter((tool): tool is LanguageModelV3FunctionTool => tool.type === "function")
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
    }))
}

function canonicalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => entry === undefined ? null : canonicalizeForHash(entry))
  }

  if (value && typeof value === "object") {
    const canonical: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key]
      if (entry !== undefined) canonical[key] = canonicalizeForHash(entry)
    }
    return canonical
  }

  if (typeof value === "number" && !Number.isFinite(value)) return null
  return value
}

function toolsetHash(
  definitions: Array<Pick<LanguageModelV3FunctionTool, "name" | "description" | "inputSchema">>,
): string {
  const canonicalDefinitions = definitions
    .map((definition) => canonicalizeForHash(definition))
    .sort((left, right) => {
      const serializedLeft = JSON.stringify(left)
      const serializedRight = JSON.stringify(right)
      return serializedLeft < serializedRight ? -1 : serializedLeft > serializedRight ? 1 : 0
    })
  return createHash("sha256").update(JSON.stringify({
    version: 2,
    definitions: canonicalDefinitions,
  })).digest("hex")
}

// ---------------------------------------------------------------------------
// Data conversion helpers
// ---------------------------------------------------------------------------

/**
 * Convert AI SDK V3 data content to a base64 string.
 *
 * LanguageModelV3DataContent can be:
 * - Uint8Array → convert to base64
 * - string → assume already base64-encoded
 * - URL → convert URL string to base64 (data URLs decoded, http URLs passed as-is)
 */
function toBase64Data(data: Uint8Array | string | URL): string {
  if (data instanceof Uint8Array) {
    return Buffer.from(data).toString("base64")
  }

  if (data instanceof URL) {
    // Data URLs: extract the base64 payload
    if (data.protocol === "data:") {
      const href = data.href
      const base64Marker = ";base64,"
      const markerIndex = href.indexOf(base64Marker)
      if (markerIndex !== -1) {
        return href.slice(markerIndex + base64Marker.length)
      }
      // Non-base64 data URL — extract after comma as fallback
      const commaIndex = href.indexOf(",")
      if (commaIndex !== -1) {
        return href.slice(commaIndex + 1)
      }
    }
    // For http/https URLs, return the URL string — the ACP server
    // will need to fetch it. This is a best-effort fallback.
    return data.href
  }

  // Already a string — assume base64
  return data
}

/**
 * Normalize an AI SDK mediaType to a concrete MIME type.
 *
 * AI SDK may send `image/*` as a wildcard; default to `image/jpeg`.
 */
function normalizeMediaType(mediaType: string): string {
  if (mediaType === "image/*") return "image/jpeg"
  return mediaType
}

/**
 * Check if a media type represents an image.
 */
function isImageMediaType(mediaType: string): boolean {
  return mediaType.startsWith("image/") || mediaType === "image/*"
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** State for an ongoing prompt paused waiting for tool results. */
interface PendingTurnState {
  sessionId: string
  promptPromise: Promise<{ stopReason: string }>
  pendingToolCalls: Map<string, PendingToolCall>
  outputCharCount: number
  streamSegment: number
  promptAbort: AbortController
}

export interface KiroACPModelConfig {
  client: ACPClient
  sessionId?: string
  /** Max context window in tokens. Default: 1_000_000. */
  contextWindow?: number
  /** Default reasoning effort, resolved by the provider. Per-call `providerOptions.kiro.reasoningEffort` overrides it. */
  effort?: string
  /**
   * Lazy accessor for an isolated ACPClient used to serve ephemeral
   * (toolless) calls — e.g. title generation. When provided,
   * `doStream` calls without tools route to a child KiroACPLanguageModel
   * backed by this client, isolating them from the main shared kiro-cli
   * process. Optional: when absent, all calls use `client` (legacy behavior).
   */
  getEphemeralClient?: () => ACPClient
  /**
   * Provider-level shared session-affinity intercept state (tracked message
   * hashes per affinity key). When provided, `doStream`/`doGenerate` apply
   * the session-affinity/reset intercept as a pre-step. Models created
   * internally (ephemeral/subagent children) are constructed WITHOUT it so
   * the intercept runs exactly once at the provider-created model boundary,
   * never on inner models.
   */
  affinityPrompts?: Map<string, string[]>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract tool name and clean args from an ACP tool_call notification.
 *
 * Tool name is embedded in `title` as "Running: @<source>/<name>".
 * Internal kiro-cli fields (like `__tool_use_purpose`) are stripped
 * for correlation matching against IPC calls.
 */
export function parseToolCallNotification(update: Record<string, unknown>): {
  toolCallId: string | undefined
  toolName: string | undefined
  args: Record<string, unknown>
} {
  // Tool call ID: prefer toolCallId, fall back to callId
  const toolCallId = (update.toolCallId as string | undefined)
    ?? (update.callId as string | undefined)

  const rawInput = update.rawInput as Record<string, unknown> | undefined

  // Tool name: prefer title (Running: @source/name), fall back to toolName, then name
  let toolName: string | undefined
  const title = update.title as string | undefined
  if (title) {
    const match = title.match(/\/([^/]+)$/)
    if (match) {
      toolName = match[1]
    }
  }

  // Fallback: direct toolName field
  if (!toolName && typeof update.toolName === "string") {
    toolName = update.toolName
  }

  // Fallback: name field (may be a path like "@server/tool" — extract last segment)
  if (!toolName && typeof update.name === "string") {
    const match = update.name.match(/\/([^/]+)$/)
    toolName = match ? match[1] : update.name
  }

  const args: Record<string, unknown> = {}
  if (rawInput) {
    for (const [key, value] of Object.entries(rawInput)) {
      if (!key.startsWith("__")) {
        args[key] = value
      }
    }
  }

  return { toolCallId, toolName, args }
}

function emptyUsage(): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: undefined,
      text: undefined,
      reasoning: undefined,
    },
  }
}

/**
 * Estimate token usage from streamed output and context usage percentage.
 *
 * ACP doesn't provide token counts directly. We estimate:
 * - Output tokens: ~1 token per 4 characters
 * - Total tokens: contextUsagePercentage (0-100 scale) × context window
 * - Input tokens: total - output
 */
function estimateUsage(
  outputCharCount: number,
  contextPercentage: number | undefined,
  contextWindow: number,
): LanguageModelV3Usage {
  const output = Math.round(outputCharCount / 4)

  const total = contextPercentage != null
    ? Math.round((contextPercentage / 100) * contextWindow)
    : undefined

  const input = total != null ? Math.max(0, total - output) : undefined

  return {
    inputTokens: {
      total: input,
      noCache: input,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: output > 0 ? output : undefined,
      text: output > 0 ? output : undefined,
      reasoning: undefined,
    },
  }
}

function mapStopReason(stopReason: string): LanguageModelV3FinishReason {
  switch (stopReason) {
    case "end_turn":
      return { unified: "stop", raw: stopReason }
    case "max_tokens":
      return { unified: "length", raw: stopReason }
    case "tool_use":
      return { unified: "tool-calls", raw: stopReason }
    case "cancelled":
      return { unified: "error", raw: "cancelled" }
    case "content_filter":
      return { unified: "content-filter", raw: stopReason }
    default:
      return { unified: "other", raw: stopReason }
  }
}

// ---------------------------------------------------------------------------
// Credits metering
// ---------------------------------------------------------------------------

/**
 * Metering unit kiro-cli reports cost in. Single internal source for the
 * unit literal — every emission echoes the unit FROM the metering data
 * (`creditsUnit`), so downstream consumers read value + unit from emitted
 * metadata instead of hardcoding a unit anywhere.
 */
const KIRO_METERING_UNIT = "credit"

/** Extract the credit metering entry from ACP session metadata, if present. */
function findCreditEntry(
  metadata: SessionMetadata | undefined,
): { unit: string; value: number } | undefined {
  return metadata?.meteringUsage?.find((m) => m.unit === KIRO_METERING_UNIT)
}

/**
 * Build the part-level `{ kiro: { credits, creditsUnit } }` provider metadata
 * for a completed turn, or undefined when credits are unknown — so parts
 * never carry an empty/NaN `kiro` key.
 */
function creditsProviderMetadata(
  creditEntry: { unit: string; value: number } | undefined,
): SharedV3ProviderMetadata | undefined {
  if (!creditEntry || !Number.isFinite(creditEntry.value)) return undefined
  return { kiro: { credits: creditEntry.value, creditsUnit: creditEntry.unit } }
}

// ---------------------------------------------------------------------------
// Error message extraction
// ---------------------------------------------------------------------------

function extractErrorMessage(err: unknown): string {
  // -32603 is the GENERIC JSON-RPC "Internal error", NOT a token-expiry signal.
  // Only claim an auth problem when kiro-cli itself reports NOT logged in (per
  // the whoami --format json detection rule in kiro-auth); otherwise surface
  // kiro-cli's original message, which carries the real cause. Even when
  // corroborated, point the user at the diagnostics rather than asserting
  // "token expired" (kiro-cli auto-re-authenticates, so a stale token is rarely
  // the real cause). verifyAuth() is synchronous with a bounded timeout and
  // runs only on this error path. ASCII punctuation only (no em/en dashes).
  if (err instanceof KiroACPError && err.code === -32603) {
    if (!verifyAuth().authenticated) {
      return `Kiro could not complete the request and does not appear logged in. Run 'kiro-cli whoami' to check auth and 'kiro-cli doctor' to diagnose installation, credential, or environment issues; then 'kiro-cli login' if needed (or /connect in opencode). Original: ${err.message}`
    }
    return err.message || `Kiro internal error (-32603)`
  }
  if (err instanceof Error) return err.message
  return String(err)
}

// ---------------------------------------------------------------------------
// E2E debug observability (env-gated, zero effect when unset)
// ---------------------------------------------------------------------------

/**
 * Append one JSONL record per intercepted call to `$KIRO_ACP_DEBUG_FILE`,
 * capturing the affinity headers BEFORE and AFTER the session-affinity
 * intercept — the only way to observe `x-session-reset` at the header level
 * from outside (a host consumes the rewritten options in-process).
 *
 * Strictly best-effort and inert unless the env var is set; never throws.
 */
function debugLogIntercept(
  modelId: string,
  before: LanguageModelV3CallOptions,
  after: LanguageModelV3CallOptions,
): void {
  const file = process.env.KIRO_ACP_DEBUG_FILE
  if (!file) return
  try {
    const record = {
      ts: new Date().toISOString(),
      model: modelId,
      affinityIn: before.headers?.["x-session-affinity"] ?? null,
      affinityOut: after.headers?.["x-session-affinity"] ?? null,
      reset: after.headers?.["x-session-reset"] === "true",
      tools: (before.tools ?? []).length,
      promptRoles: before.prompt.map((m) => m.role).join(","),
    }
    appendFileSync(file, JSON.stringify(record) + "\n")
  } catch {
    // Observability must never affect the call path
  }
}

/**
 * Log a swallowed `setEffort` failure to `$KIRO_ACP_DEBUG_FILE` so it stays
 * diagnosable. Best-effort, inert unless the env var is set; never throws.
 */
function debugLogEffortFailure(
  modelId: string,
  sessionId: string,
  requested: string,
  err: unknown,
): void {
  const file = process.env.KIRO_ACP_DEBUG_FILE
  if (!file) return
  try {
    const record = {
      ts: new Date().toISOString(),
      model: modelId,
      sessionId,
      effortRequested: requested,
      effortError: err instanceof Error ? err.message : String(err),
    }
    appendFileSync(file, JSON.stringify(record) + "\n")
  } catch {
    // Observability must never affect the call path
  }
}

/**
 * Extract system prompt and latest user message from a LanguageModelV3Prompt.
 *
 * Assistant and tool messages are skipped — kiro-cli's ACP session maintains
 * its own conversation history. Including them would duplicate every turn.
 */
function extractPrompt(prompt: LanguageModelV3Prompt): {
  systemPrompt: string | undefined
  userParts: ContentBlock[]
} {
  const systemParts: string[] = []
  let lastUserParts: ContentBlock[] = []

  for (const message of prompt) {
    if (message.role === "system") {
      systemParts.push(message.content)
      continue
    }

    if (message.role === "user") {
      const parts: ContentBlock[] = []
      for (const part of message.content) {
        if (part.type === "text") {
          parts.push({ type: "text", text: part.text })
          continue
        }
        if (part.type === "file" && isImageMediaType(part.mediaType)) {
          parts.push({
            type: "image",
            data: toBase64Data(part.data),
            mimeType: normalizeMediaType(part.mediaType),
          })
        }
      }
      lastUserParts = parts
    }
  }

  const systemPrompt = systemParts.length > 0 ? systemParts.join("\n\n") : undefined

  return {
    systemPrompt,
    userParts: lastUserParts,
  }
}

/**
 * Format a full conversation prompt as a single message for session replay.
 *
 * Used when resetting a session (revert/fork): the AI SDK prompt contains
 * the full conversation history, but kiro-cli has no session state. We format
 * everything as a single user message with the history as context and the
 * last user message as the actual query.
 */
function formatConversationReplay(prompt: LanguageModelV3Prompt): string {
  const systemParts: string[] = []
  const historyParts: string[] = []
  let lastUserMessage = ""

  for (const message of prompt) {
    if (message.role === "system") {
      systemParts.push(message.content)
      continue
    }

    if (message.role === "user") {
      // Flush previous user message to history (if any)
      if (lastUserMessage) {
        historyParts.push(`User: ${lastUserMessage}`)
      }
      const parts: string[] = []
      for (const part of message.content) {
        if (part.type === "text") {
          parts.push(part.text)
          continue
        }
        if (part.type === "file" && isImageMediaType(part.mediaType)) {
          parts.push(`[Image: ${normalizeMediaType(part.mediaType)}]`)
        } else if (part.type === "file") {
          parts.push(`[File: ${part.mediaType}]`)
        }
      }
      lastUserMessage = parts.join("\n")
      continue
    }

    if (message.role === "assistant") {
      const parts: string[] = []
      for (const part of message.content) {
        if (part.type === "text") {
          parts.push(part.text)
        }
        // Skip tool-call parts — including tool names primes the model
        // to reference tools that may not be available in the new session.
      }
      if (parts.length > 0) {
        historyParts.push(`Assistant: ${parts.join("\n")}`)
      }
      continue
    }

    // Skip tool-result messages entirely — they reference tool names
    // and outputs that could mislead the model about available tools.
    if (message.role === "tool") {
      continue
    }
  }

  const sections: string[] = []

  if (systemParts.length > 0) {
    sections.push(`<system_instructions>\n${systemParts.join("\n\n")}\n</system_instructions>`)
  }

  if (historyParts.length > 0) {
    sections.push(`<context>\n${historyParts.join("\n\n")}\n</context>`)
  }

  sections.push(`Resume and act on the following message.\n\n${lastUserMessage}`)

  return sections.join("\n\n")
}

// ---------------------------------------------------------------------------
// Debounce timer duration for batching parallel tool calls (ms)
// ---------------------------------------------------------------------------
const TOOL_CALL_DEBOUNCE_MS = 100

// ---------------------------------------------------------------------------
// KiroACPLanguageModel
// ---------------------------------------------------------------------------

/**
 * LanguageModelV3 implementation backed by kiro-cli via ACP.
 *
 * Each doStream() creates a new ACP session with its own tools file.
 * Sessions with affinity (`x-session-affinity` header) are persisted
 * and resumed; sessions without affinity are one-shot.
 *
 * System prompts are injected via `<system_instructions>` tags.
 * Tool calls use the standard AI SDK contract (no providerExecuted flag).
 */
export class KiroACPLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const
  readonly provider = "kiro-acp"
  readonly modelId: string
  readonly defaultObjectGenerationMode = undefined
  readonly supportedUrls: Record<string, RegExp[]> = {}

  private readonly client: ACPClient
  private readonly config: KiroACPModelConfig
  private currentModelId: string | null = null
  private currentEffort: string | null = null
  private initPromise: Promise<void> | null = null
  private totalCredits = 0
  private currentAffinityId: string | undefined

  /**
   * Per-session tools file paths. Each ACP session gets its own file
   * so concurrent sessions don't overwrite each other's tool definitions.
   */
  private sessionToolsFiles = new Map<
    string,
    {
      filePath: string
      toolNames: string
      toolsetHash: string
      kiroToOriginalToolName: Map<string, string>
    }
  >()

  /**
   * Per-session state for prompts paused waiting for tool results.
   * When a tool call arrives via IPC, we close the stream and store state here.
   * The next doStream() (with tool results) uses this to resume.
   */
  private pendingTurns = new Map<string, PendingTurnState>()

  /**
   * Isolated ACP clients for subagent sessions (separate kiro-cli processes).
   * Each subagent gets its own process to prevent tool leakage between parent
   * and child sessions that would otherwise share the same kiro-cli process.
   */
  private subClients = new Map<string, {
    client: ACPClient
    model: KiroACPLanguageModel
    timer: ReturnType<typeof setTimeout> | null
  }>()

  /**
   * Cached ephemeral child model (lazy-initialized on first toolless call).
   * Backed by the provider-owned ephemeral ACPClient, this model serves
   * toolless flows on a separate kiro-cli process — preventing contention
   * with the main client used by tooled flows.
   */
  private ephemeralModel: KiroACPLanguageModel | null = null

  constructor(modelId: string, config: KiroACPModelConfig) {
    this.modelId = modelId
    this.client = config.client
    this.config = config
  }

  // -------------------------------------------------------------------------
  // Credits tracking
  // -------------------------------------------------------------------------

  getTotalCredits(): number {
    return this.totalCredits
  }

  // -------------------------------------------------------------------------
  // Session creation — one session per doStream() lifecycle
  // -------------------------------------------------------------------------

  /**
   * Ensure the ACP client is started. Safe to call multiple times.
   * If initialization fails, subsequent calls will retry.
   */
  private async ensureClient(toolsFilePath?: string): Promise<void> {
    await this.client.withEnsureClientLock(async () => {
      // If client was started without tools (e.g., title generation) and now
      // we have tools, restart it so the MCP bridge gets the correct config.
      if (this.client.isRunning() && toolsFilePath && this.client.startedToolless) {
        await this.client.stop()
        this.client.startedToolless = false
        this.initPromise = null
        // Fall through to start with tools
      } else if (this.client.isRunning()) {
        return
      }

      if (this.initPromise) {
        await this.initPromise
        if (this.client.isRunning()) return
        // Client died after init succeeded — clear and reinitialize
        this.initPromise = null
      }

      if (!toolsFilePath) {
        this.client.startedToolless = true
      }

      this.initPromise = this.client.start(toolsFilePath).then(() => {})

      try {
        await this.initPromise
      } catch (err) {
        this.initPromise = null
        throw err
      }
    })
  }

  /**
   * Create a new ACP session for this doStream() call.
   *
   * Each doStream() gets a fresh session with its own tools file.
   * With affinity, tries to resume a persisted session first.
   * Without affinity (subagent calls), always creates fresh.
   */
  private async acquireSession(
    tools?: Array<LanguageModelV3FunctionTool | LanguageModelV3ProviderTool>,
  ): Promise<ACPSession> {
    const expectedToolDefinitions = functionToolDefinitions(tools)
    const toolNameMapping = buildToolNameMapping(
      expectedToolDefinitions.map((tool) => tool.name),
    )
    const expectedToolNames = expectedToolDefinitions
      .map((tool) => toolNameMapping.originalToKiro.get(tool.name)!)
      .sort()
    const expectedToolsetHash = toolsetHash(expectedToolDefinitions)

    // Write tools BEFORE creating the session so the MCP bridge
    // has them from the very first `tools/list` query.
    let toolsFilePath: string | undefined
    let toolNames = ""
    if (tools && tools.length > 0) {
      const streamId = randomBytes(4).toString("hex")
      toolsFilePath = this.client.createSessionToolsFilePath(streamId)
      toolNames = this.writeToolsToFile(toolsFilePath, tools)
    }

    await this.ensureClient(toolsFilePath)

    // Re-inject ipcPort now that the IPC server is running
    if (toolsFilePath && this.client.getIpcPort() != null) {
      this.ensureIpcPortInToolsFile(toolsFilePath)
    }

    // Validate the tools file has all expected definitions and correct IPC wiring
    if (toolsFilePath && tools && tools.length > 0) {
      this.ensureToolsFileReady(toolsFilePath, tools)
    }

    return this.client.withSessionSetupLock(async () => {
      // Try loading an existing session (affinity-based)
      if (this.currentAffinityId) {
        let persisted = loadPersistedSession(this.client.getCwd(), this.currentAffinityId)
        if (persisted && persisted.toolsetHash !== expectedToolsetHash) {
          clearPersistedSession(this.client.getCwd(), this.currentAffinityId)
          persisted = null
        }

        // A configured session ID is safe to resume only after this provider
        // has persisted a matching definition fingerprint for it. Otherwise
        // it is indistinguishable from a legacy session with stale tools.
        if (this.config.sessionId && persisted?.kiroSessionId === this.config.sessionId) {
          try {
            const toolsRevision = this.client.getToolsRevision?.() ?? 0
            const loaded = await this.client.loadSession(this.config.sessionId)
            const sessionId = loaded.sessionId || this.config.sessionId
            if (!loaded.sessionId) loaded.sessionId = sessionId
            await this.ensureSessionMode(loaded, expectedToolNames, toolsRevision)
            if (this.currentModelId === null) {
              this.currentModelId = loaded.models.currentModelId
            }
            if (toolsFilePath) {
              this.sessionToolsFiles.set(sessionId, {
                filePath: toolsFilePath,
                toolNames,
                toolsetHash: expectedToolsetHash,
                kiroToOriginalToolName: toolNameMapping.kiroToOriginal,
              })
            }
            persistSession(
              this.client.getCwd(),
              sessionId,
              this.currentAffinityId,
              expectedToolsetHash,
            )
            return loaded
          } catch (err) {
            clearPersistedSession(this.client.getCwd(), this.currentAffinityId)
            persisted = null
            // Fall through to create a new session
          }
        }

        if (persisted) {
          try {
            const toolsRevision = this.client.getToolsRevision?.() ?? 0
            const session = await this.client.loadSession(persisted.kiroSessionId)
            const sessionId = session.sessionId || persisted.kiroSessionId
            if (!session.sessionId) session.sessionId = sessionId
            if (session) {
              await this.ensureSessionMode(session, expectedToolNames, toolsRevision)
              if (this.currentModelId === null) {
                this.currentModelId = session.models?.currentModelId ?? null
              }
              if (toolsFilePath) {
                this.sessionToolsFiles.set(sessionId, {
                  filePath: toolsFilePath,
                  toolNames,
                  toolsetHash: expectedToolsetHash,
                  kiroToOriginalToolName: toolNameMapping.kiroToOriginal,
                })
              }
              persistSession(
                this.client.getCwd(),
                sessionId,
                this.currentAffinityId,
                expectedToolsetHash,
              )
              return session
            }
          } catch (err: unknown) {
            clearPersistedSession(this.client.getCwd(), this.currentAffinityId)
            // Fall through to create new session
          }
        }
      }

      // Create a new session with this stream's tools file path.
      // createSessionWithToolsPath() atomically rewrites the agent config
      // before calling session/new.
      const toolsRevision = this.client.getToolsRevision?.() ?? 0
      const session = toolsFilePath
        ? await this.client.createSessionWithToolsPath(toolsFilePath)
        : await this.client.createSession()
      await this.ensureSessionMode(session, expectedToolNames, toolsRevision)
      if (this.currentModelId === null) {
        this.currentModelId = session.models.currentModelId
      }

      if (toolsFilePath) {
        this.sessionToolsFiles.set(session.sessionId, {
          filePath: toolsFilePath,
          toolNames,
          toolsetHash: expectedToolsetHash,
          kiroToOriginalToolName: toolNameMapping.kiroToOriginal,
        })
      }

      if (this.currentAffinityId) {
        persistSession(
          this.client.getCwd(),
          session.sessionId,
          this.currentAffinityId,
          expectedToolsetHash,
        )
      }

      return session
    })
  }

  /**
   * Clean up after a doStream() lifecycle completes.
   *
   * With affinity: persist mapping, keep kiro session alive, remove tools file.
   * Without affinity: full cleanup (one-shot session).
   */
  private cleanupAfterStream(sessionId: string): void {
    if (this.currentAffinityId) {
      const persistedToolsetHash =
        this.sessionToolsFiles.get(sessionId)?.toolsetHash ?? toolsetHash([])
      persistSession(
        this.client.getCwd(),
        sessionId,
        this.currentAffinityId,
        persistedToolsetHash,
      )
      // Keep tools file alive — the MCP bridge still references it between turns.
      // Only ephemeral (no affinity) sessions delete their tools file.
    } else {
      this.cleanupSessionToolsFile(sessionId)
    }
  }

  /**
   * Ensure a session uses the correct agent mode.
   *
   * Only the first session inherits the `--agent` flag's mode.
   * Subsequent sessions default to `kiro_default`, so we explicitly
   * set the mode after creation/loading.
   */
  private async ensureSessionMode(
    session: ACPSession,
    expectedToolNames: string[] = [],
    afterRevision?: number,
  ): Promise<void> {
    const agentName = this.client.getAgentName()
    if (!agentName) return

    const modeChanged = session.modes.currentModeId !== agentName
    if (modeChanged) {
      await this.client.setMode(session.sessionId, agentName)
      session.modes.currentModeId = agentName
    }

    if (expectedToolNames.length === 0) {
      if (modeChanged) {
        await this.client.waitForToolsReady({ timeoutMs: TOOL_READY_TIMEOUT_MS })
      }
      return
    }

    let observed = await this.client.waitForToolsReady({
      timeoutMs: TOOL_READY_TIMEOUT_MS,
      expectedTools: expectedToolNames,
      afterRevision,
    })
    let missing = this.missingExpectedTools(observed, expectedToolNames)

    if (missing.length > 0) {
      const refreshRevision = this.client.getToolsRevision?.() ?? 0
      await this.client.setMode(session.sessionId, agentName)
      observed = await this.client.waitForToolsReady({
        timeoutMs: TOOL_READY_TIMEOUT_MS,
        expectedTools: expectedToolNames,
        afterRevision: refreshRevision,
      })
      missing = this.missingExpectedTools(observed, expectedToolNames)
    }

    if (missing.length > 0) {
      const preview = missing.slice(0, 10).join(", ")
      const remainder = missing.length > 10 ? ` (+${missing.length - 10} more)` : ""
      throw new KiroACPConnectionError(
        `Kiro session did not expose the expected MCP tools: ${preview}${remainder}`,
      )
    }
  }

  private missingExpectedTools(observed: Array<{ name: string }>, expected: string[]): string[] {
    const names = new Set(observed.map((tool) => tool.name))
    return expected.filter((name) => !names.has(name))
  }

  /** Switch model on a session if the requested modelId differs. */
  private async ensureModel(session: ACPSession): Promise<boolean> {
    if (this.currentModelId === this.modelId) return false

    await this.client.setModel(session.sessionId, this.modelId)
    this.currentModelId = this.modelId
    return true
  }

  /**
   * Resolve requested effort: per-call `providerOptions.kiro.reasoningEffort`,
   * else `config.effort`, else the model's native default. The native-default
   * fallback resets an unset turn instead of leaving effort sticky.
   */
  private resolveRequestedEffort(options: LanguageModelV3CallOptions): string | undefined {
    const fromRequest = options.providerOptions?.kiro?.reasoningEffort
    if (typeof fromRequest === "string") return fromRequest
    return this.config.effort ?? defaultEffortFor(this.modelId)
  }

  /**
   * Apply an effort level to the session. Never throws and never changes the
   * stop reason: unsupported models/levels and any setEffort failure are
   * silent no-ops.
   */
  private async ensureEffort(session: ACPSession, requested: string | undefined): Promise<void> {
    if (!requested) return

    // Validate against the supported set before sending; out-of-set is a no-op.
    const supported = reasoningEffortsFor(this.modelId)
    if (supported.length === 0 || !supported.some((level) => level === requested)) {
      return
    }

    // Skip redundant calls (mirrors the currentModelId guard).
    if (this.currentEffort === requested) return

    try {
      const result = await this.client.setEffort(session.sessionId, requested)
      if (result.success) {
        this.currentEffort = requested
      }
      // success:false (unsupported model/level): leave currentEffort untouched.
    } catch (err) {
      // Swallow any setEffort error; log it env-gated for diagnosis.
      debugLogEffortFailure(this.modelId, session.sessionId, requested, err)
    }
  }

  // -------------------------------------------------------------------------
  // Session persistence
  // -------------------------------------------------------------------------

  setAffinityId(affinityId: string | undefined): void {
    this.currentAffinityId = affinityId
  }

  // -------------------------------------------------------------------------
  // Session rehydration
  // -------------------------------------------------------------------------

  getSessionId(): string | null {
    const firstPending = this.pendingTurns.keys().next()
    return firstPending.done ? null : firstPending.value
  }

  /**
   * Inject conversation context into a new session.
   * Used when session/load fails and we need to rehydrate from the consumer's history.
   */
  async injectContext(summary: string): Promise<void> {
    const session = await this.acquireSession()

    try {
      await this.client.prompt({
        sessionId: session.sessionId,
        prompt: [{
          type: "text",
          text: `<context_rehydration>\nThe following is a summary of our previous conversation that was interrupted:\n\n${summary}\n\nPlease acknowledge this context and continue from where we left off.\n</context_rehydration>`,
        }],
        onUpdate: () => {},
      })
    } finally {
      this.cleanupAfterStream(session.sessionId)
    }
  }

  // -------------------------------------------------------------------------
  // Dynamic tool synchronization — per-session tools files
  // -------------------------------------------------------------------------

  /**
   * Write tool definitions to a tools file in MCP format.
   * Only function tools are synced — provider tools are handled by the provider itself.
   * @returns Sorted tool names string (for change detection).
   */
  private writeToolsToFile(
    toolsFilePath: string,
    tools: Array<LanguageModelV3FunctionTool | LanguageModelV3ProviderTool>,
  ): string {
    const functionTools = tools
      .filter((tool): tool is LanguageModelV3FunctionTool => tool.type === "function")
    const toolNameMapping = buildToolNameMapping(functionTools.map((tool) => tool.name))
    const newTools: MCPToolDefinition[] = functionTools
      .map((tool) => ({
        name: toolNameMapping.originalToKiro.get(tool.name)!,
        description: tool.description?.trim() || `Invoke ${tool.name}`,
        inputSchema: tool.inputSchema as MCPToolDefinition["inputSchema"],
      }))

    const toolNames = newTools.map(t => t.name).sort().join(",")

    const ipcPort = this.client.getIpcPort()
    const ipcSecret = this.client.getIpcSecret()
    const toolsData: MCPToolsFile = {
      tools: newTools,
      cwd: this.client.getCwd(),
      ...(ipcPort != null ? { ipcPort } : {}),
      ...(ipcSecret ? { ipcSecret } : {}),
    }
    const tmpPath = `${toolsFilePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
    writeFileSync(tmpPath, JSON.stringify(toolsData, null, 2), { mode: 0o600 })
    renameSync(tmpPath, toolsFilePath)
    return toolNames
  }

  /**
   * Inject IPC port into a tools file if missing.
   * Needed when tools are written before ensureClient() starts the IPC server.
   */
  private ensureIpcPortInToolsFile(toolsFilePath: string): void {
    const ipcPort = this.client.getIpcPort()
    if (ipcPort == null) return

    try {
      const raw = readFileSync(toolsFilePath, "utf-8")
      const parsed = JSON.parse(raw) as MCPToolsFile
      const ipcSecret = this.client.getIpcSecret()
      if (parsed.ipcPort === ipcPort && parsed.ipcSecret === ipcSecret) return

      parsed.ipcPort = ipcPort
      if (ipcSecret) parsed.ipcSecret = ipcSecret
      const tmpPath = `${toolsFilePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
      writeFileSync(tmpPath, JSON.stringify(parsed, null, 2), { mode: 0o600 })
      renameSync(tmpPath, toolsFilePath)
    } catch {
      // File doesn't exist or is invalid — will be written on next writeToolsToFile()
    }
  }

  /**
   * Validate the tools file has all expected tool definitions and correct IPC wiring.
   * If stale or incomplete, attempts one repair by rewriting, then validates again.
   */
  private ensureToolsFileReady(
    toolsFilePath: string,
    tools: Array<LanguageModelV3FunctionTool | LanguageModelV3ProviderTool>,
  ): void {
    const validate = (): { ok: boolean; reason?: string } => {
      try {
        const raw = readFileSync(toolsFilePath, "utf-8")
        const parsed = JSON.parse(raw) as MCPToolsFile

        const functionTools = tools
          .filter((tool): tool is LanguageModelV3FunctionTool => tool.type === "function")
        const toolNameMapping = buildToolNameMapping(functionTools.map((tool) => tool.name))
        const expectedNames = functionTools
          .map((tool) => toolNameMapping.originalToKiro.get(tool.name)!)

        const actualNames = new Set((parsed.tools ?? []).map((tool) => tool.name))
        const missing = expectedNames.filter((name) => !actualNames.has(name))

        if (missing.length > 0) {
          return { ok: false, reason: `missing tools: ${missing.join(", ")}` }
        }

        const ipcPort = this.client.getIpcPort()
        if (ipcPort != null && parsed.ipcPort !== ipcPort) {
          return { ok: false, reason: "ipcPort mismatch" }
        }

        const ipcSecret = this.client.getIpcSecret()
        if (ipcSecret && parsed.ipcSecret !== ipcSecret) {
          return { ok: false, reason: "ipcSecret mismatch" }
        }

        return { ok: true }
      } catch {
        return { ok: false, reason: "tools file unreadable" }
      }
    }

    const first = validate()
    if (first.ok) return

    // One repair attempt — rewrite the entire file
    this.writeToolsToFile(toolsFilePath, tools)

    const second = validate()
    if (!second.ok) {
      throw new KiroACPError(
        `Tools file is not ready for MCP bridge (${second.reason ?? "unknown reason"})`,
        -1,
      )
    }
  }

  private cleanupSessionToolsFile(sessionId: string): void {
    const entry = this.sessionToolsFiles.get(sessionId)
    if (!entry) return

    this.sessionToolsFiles.delete(sessionId)
    this.client.removeSessionToolsFile(entry.filePath)
  }

  // -------------------------------------------------------------------------
  // Tool result extraction from AI SDK prompt
  // -------------------------------------------------------------------------

  /**
   * Extract tool results from `role: "tool"` messages in the prompt.
   */
  private extractToolResults(prompt: LanguageModelV3Prompt): Array<{
    toolCallId: string
    toolName: string
    result: string
    content?: IPCContentBlock[]
  }> {
    const results: Array<{
      toolCallId: string
      toolName: string
      result: string
      content?: IPCContentBlock[]
    }> = []

    for (const message of prompt) {
      if (message.role !== "tool") continue

      for (const part of message.content) {
        if (part.type !== "tool-result") continue

        const output = part.output

        if (output.type === "text") {
          results.push({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            result: output.value,
          })
          continue
        }

        if (output.type === "content") {
          const contentBlocks: IPCContentBlock[] = []
          const textParts: string[] = []

          for (const contentPart of output.value) {
            if (contentPart.type === "text") {
              contentBlocks.push({ type: "text", text: contentPart.text })
              textParts.push(contentPart.text)
              continue
            }

            if (contentPart.type === "image-data") {
              contentBlocks.push({
                type: "image",
                data: contentPart.data,
                mimeType: normalizeMediaType(contentPart.mediaType),
              })
              continue
            }

            if (contentPart.type === "image-url") {
              // For URL images, include the URL as data fallback
              // The MCP bridge will convert to appropriate format
              contentBlocks.push({
                type: "image",
                data: contentPart.url,
                mimeType: normalizeMediaType("image/jpeg"),
              })
              continue
            }

            if (contentPart.type === "file-data" && isImageMediaType(contentPart.mediaType)) {
              contentBlocks.push({
                type: "image",
                data: contentPart.data,
                mimeType: normalizeMediaType(contentPart.mediaType),
              })
              continue
            }

            // Handle deprecated "media" type (some hosts, e.g. opencode, send this format)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const anyPart = contentPart as any
            if (anyPart.type === "media" && isImageMediaType(anyPart.mediaType)) {
              contentBlocks.push({
                type: "image",
                data: anyPart.data,
                mimeType: normalizeMediaType(anyPart.mediaType),
              })
              continue
            }
          }

          // Text fallback for the `result` field (backward compat)
          const resultText = textParts.length > 0
            ? textParts.join("\n")
            : JSON.stringify(output)

          // Only include content if there are image blocks
          const hasImages = contentBlocks.some((b) => b.type === "image")

          results.push({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            result: resultText,
            ...(hasImages ? { content: contentBlocks } : {}),
          })
          continue
        }

        // Fallback for unknown output types
        results.push({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          result: JSON.stringify(output),
        })
      }
    }

    return results
  }

  // -------------------------------------------------------------------------
  // LanguageModelV3 — doStream
  // -------------------------------------------------------------------------

  async doStream(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3StreamResult> {
    return this.doStreamInner(this.interceptOptions(options))
  }

  /**
   * Session-affinity/reset intercept pre-step. Applied at the top of both
   * `doStream` and `doGenerate`, BEFORE any header/affinity reading. No-op
   * (options returned untouched, same reference) when the model has no
   * provider-level affinity state — directly constructed models and
   * internal child models — or when the request carries no
   * `x-session-affinity` header.
   */
  private interceptOptions(options: LanguageModelV3CallOptions): LanguageModelV3CallOptions {
    if (!this.config.affinityPrompts) return options
    const intercepted = interceptSessionAffinity(options, this.config.affinityPrompts)
    debugLogIntercept(this.modelId, options, intercepted)
    return intercepted
  }

  /**
   * Central routing logic shared by `doStream`/`doGenerate`, running AFTER
   * the intercept pre-step: options are rewritten exactly once at the public
   * boundary, then the SDK's own affinity/reset bookkeeping below consumes
   * the rewritten headers unchanged.
   */
  private async doStreamInner(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3StreamResult> {
    const affinityId = typeof options.headers?.["x-session-affinity"] === "string"
      ? options.headers["x-session-affinity"]
      : undefined
    this.setAffinityId(affinityId)

    const isChild = typeof options.headers?.["x-parent-session-id"] === "string"
    const hasTools = (options.tools ?? []).length > 0

    // Toolless calls (e.g. title generation) → route to an isolated
    // ephemeral kiro-cli process so they can't be killed by a tooled call's
    // restart on the main client. Only active when the provider supplied a
    // getEphemeralClient (test paths constructing the model directly fall
    // through to legacy behavior on the main client).
    if (!hasTools && this.config.getEphemeralClient) {
      return this.doStreamEphemeral(options)
    }

    // Subagent with tools → use isolated client (separate kiro-cli process)
    // to prevent tool leakage from the parent session.
    if (isChild && hasTools && affinityId) {
      return this.doStreamIsolated(options, affinityId)
    }

    // Session reset: clear persisted mapping so acquireSession() creates a fresh session
    const reset = options.headers?.["x-session-reset"] === "true"
    if (reset && affinityId) {
      clearPersistedSession(this.client.getCwd(), affinityId)
    }

    const toolResults = this.extractToolResults(options.prompt)

    if (toolResults.length > 0) {
      const pendingEntry = this.findPendingTurnForResults(toolResults)
      if (pendingEntry) {
        return this.resumeWithToolResults(pendingEntry.sessionId, toolResults, options)
      }
    }

    return this.startFreshPrompt(options, reset)
  }

  // -------------------------------------------------------------------------
  // Ephemeral (toolless) isolation — separate kiro-cli process for toolless flows
  // -------------------------------------------------------------------------

  /**
   * Route a toolless doStream() call to an isolated KiroACPLanguageModel
   * backed by the provider-owned ephemeral ACPClient (separate kiro-cli
   * process). The ephemeral child model is constructed WITHOUT a
   * getEphemeralClient in its config — so its own doStream() falls through
   * to the normal (non-ephemeral) path and serves the request on the
   * ephemeral client directly. The ephemeral client is owned by the provider
   * and stopped in provider.shutdown(); no per-call cleanup is needed.
   */
  private async doStreamEphemeral(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3StreamResult> {
    if (!this.ephemeralModel) {
      const ephemeralClient = this.config.getEphemeralClient!()
      this.ephemeralModel = new KiroACPLanguageModel(this.modelId, {
        client: ephemeralClient,
        contextWindow: this.config.contextWindow,
        // Propagate the provider default so ephemeral turns inherit it.
        effort: this.config.effort,
      })
    }
    return this.ephemeralModel.doStream(options)
  }

  // -------------------------------------------------------------------------
  // Subagent isolation — separate kiro-cli process per subagent
  // -------------------------------------------------------------------------

  private static readonly SUB_CLIENT_IDLE_MS = 180_000

  /**
   * Route a subagent doStream() call to an isolated KiroACPLanguageModel
   * backed by its own ACPClient (separate kiro-cli process).
   *
   * The isolated client is reused across turns for the same affinityId
   * (tool call → tool result → continuation) and cleaned up after 3 minutes idle.
   */
  private async doStreamIsolated(
    options: LanguageModelV3CallOptions,
    affinityId: string,
  ): Promise<LanguageModelV3StreamResult> {
    let entry = this.subClients.get(affinityId)

    if (!entry) {
      const client = this.client.clone()
      const model = new KiroACPLanguageModel(this.modelId, {
        client,
        contextWindow: this.config.contextWindow,
        // Propagate the provider default so subagent turns inherit it.
        effort: this.config.effort,
      })
      entry = { client, model, timer: null }
      this.subClients.set(affinityId, entry)
    }

    // Clear any pending cleanup timer — this subagent is still active
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }

    // Delegate to the isolated model's doStream (which won't re-enter
    // doStreamIsolated because we strip x-parent-session-id)
    const isolatedOptions: LanguageModelV3CallOptions = {
      ...options,
      headers: {
        ...options.headers,
        "x-parent-session-id": undefined,
      },
    }

    const result = await entry.model.doStream(isolatedOptions)

    // Schedule cleanup — shutdown isolated client after idle timeout
    const capturedEntry = entry
    const capturedId = affinityId
    capturedEntry.timer = setTimeout(() => {
      void capturedEntry.client.stop()
      this.subClients.delete(capturedId)
    }, KiroACPLanguageModel.SUB_CLIENT_IDLE_MS)

    return result
  }

  /**
   * Shutdown all isolated subagent clients.
   * Call this when the parent provider is shutting down.
   */
  async shutdownSubClients(): Promise<void> {
    for (const [id, entry] of this.subClients) {
      if (entry.timer) clearTimeout(entry.timer)
      await entry.client.stop()
    }
    this.subClients.clear()
  }

  // -------------------------------------------------------------------------
  // Pending turn lookup
  // -------------------------------------------------------------------------

  /** Find the pending turn whose tool call IDs match the given tool results. */
  private findPendingTurnForResults(
    toolResults: Array<{ toolCallId: string }>,
  ): { sessionId: string; state: PendingTurnState } | null {
    for (const [sessionId, state] of this.pendingTurns) {
      const pendingCallIds = new Set(state.pendingToolCalls.keys())
      const hasMatch = toolResults.some(r => pendingCallIds.has(r.toolCallId))
      if (hasMatch) return { sessionId, state }
    }
    return null
  }

  // -------------------------------------------------------------------------
  // Shared stream infrastructure for prompt flows
  // -------------------------------------------------------------------------

  /**
   * Create the stream infrastructure shared by both fresh prompts and
   * tool-result resumptions.
   *
   * Returns the readable stream, an update handler for ACP notifications,
   * and completion/error handlers that wire up the prompt promise to the
   * stream lifecycle.
   */
  private createPromptStream(params: {
    sessionId: string
    promptAbort: AbortController
    initialOutputCharCount: number
    streamSegment: number
    options: LanguageModelV3CallOptions
    /** Called when tool calls are flushed to save/update pending turn state. */
    savePendingTurn: (state: {
      pendingToolCalls: Map<string, PendingToolCall>
      outputCharCount: number
      nextSegment: number
    }) => void
  }): {
    readable: ReadableStream<LanguageModelV3StreamPart>
    onUpdate: (update: SessionUpdate) => void
    onToolCall: (pendingCall: PendingToolCall) => void
    attachPromise: (promptPromise: Promise<{ stopReason: string }>) => void
  } {
    const {
      sessionId,
      promptAbort,
      initialOutputCharCount,
      streamSegment,
      options,
      savePendingTurn,
    } = params

    let textStarted = false
    let reasoningStarted = false
    let outputCharCount = initialOutputCharCount
    let streamClosed = false
    const textId = `txt-${streamSegment}`
    const reasoningId = `reasoning-${streamSegment}`

    const { readable, writable } = new TransformStream<LanguageModelV3StreamPart>()
    const writer = writable.getWriter()

    // Chain writes sequentially to respect backpressure and preserve ordering
    let writeChain = Promise.resolve()
    const writePart = (part: LanguageModelV3StreamPart) => {
      if (streamClosed) return
      writeChain = writeChain.then(() => writer.write(part)).catch(() => { streamClosed = true })
    }

    let bufferedToolCalls: PendingToolCall[] = []
    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    let userAbortHandler: (() => void) | undefined
    if (options.abortSignal) {
      userAbortHandler = () => promptAbort.abort()
      options.abortSignal.addEventListener("abort", userAbortHandler, { once: true })
    }

    const removeAbortListener = (): void => {
      if (options.abortSignal && userAbortHandler) {
        options.abortSignal.removeEventListener("abort", userAbortHandler)
      }
    }

    const laneRouter = this.client.getLaneRouter()

    const flushToolCalls = async (): Promise<void> => {
      if (streamClosed || bufferedToolCalls.length === 0) return

      if (reasoningStarted) {
        reasoningStarted = false
        writePart({ type: "reasoning-end", id: reasoningId })
      }
      if (textStarted) {
        textStarted = false
        writePart({ type: "text-end", id: textId })
      }

      for (const call of bufferedToolCalls) {
        const argsJson = JSON.stringify(call.args)
        writePart({ type: "tool-input-start", id: call.callId, toolName: call.toolName })
        writePart({ type: "tool-input-delta", id: call.callId, delta: argsJson })
        writePart({ type: "tool-input-end", id: call.callId })
        writePart({
          type: "tool-call",
          toolCallId: call.callId,
          toolName: call.toolName,
          input: argsJson,
        })
      }

      savePendingTurn({
        pendingToolCalls: new Map(bufferedToolCalls.map(c => [c.callId, c])),
        outputCharCount,
        nextSegment: streamSegment + 1,
      })

      const metadata = this.client.getMetadata(sessionId)
      writePart({
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "tool_use" },
        usage: estimateUsage(outputCharCount, metadata?.contextUsagePercentage, this.config.contextWindow ?? 1_000_000),
      })

      removeAbortListener()

      streamClosed = true
      bufferedToolCalls = []
      await writeChain
      await writer.close()
    }

    const onToolCall = (pendingCall: PendingToolCall): void => {
      const originalToolName = this.sessionToolsFiles
        .get(sessionId)
        ?.kiroToOriginalToolName.get(pendingCall.toolName)
      bufferedToolCalls.push(originalToolName
        ? { ...pendingCall, toolName: originalToolName }
        : pendingCall)

      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        void flushToolCalls()
      }, TOOL_CALL_DEBOUNCE_MS)
    }

    const onUpdate = (update: SessionUpdate): void => {
      if (streamClosed) return

      const updateType = update.sessionUpdate

      if (updateType === "agent_message_chunk") {
        const text = (update.content as { text?: string } | undefined)?.text
        if (text) {
          outputCharCount += text.length
          if (!textStarted) {
            textStarted = true
            writePart({ type: "stream-start", warnings: [] })
            writePart({ type: "text-start", id: textId })
          }
          writePart({ type: "text-delta", id: textId, delta: text })
        }
      } else if (updateType === "agent_thought_chunk") {
        const text = (update.content as { text?: string } | undefined)?.text
        if (text) {
          if (textStarted) {
            textStarted = false
            writePart({ type: "text-end", id: textId })
          }
          if (!reasoningStarted) {
            reasoningStarted = true
            writePart({ type: "stream-start", warnings: [] })
            writePart({ type: "reasoning-start", id: reasoningId })
          }
          writePart({ type: "reasoning-delta", id: reasoningId, delta: text })
        }
      } else if (updateType === "tool_call") {
        const { toolCallId, toolName, args: cleanArgs } = parseToolCallNotification(
          update as Record<string, unknown>,
        )
        if (toolCallId && toolName) {
          laneRouter?.correlate(sessionId, toolCallId, toolName, cleanArgs)
        }
      }
    }

    const attachPromise = (promptPromise: Promise<{ stopReason: string }>): void => {
      promptPromise
        .then(async (result) => {
          if (streamClosed) return

          if (debounceTimer) {
            clearTimeout(debounceTimer)
            debounceTimer = null
          }

          // Flush buffered tool calls that arrived during debounce window
          if (bufferedToolCalls.length > 0) {
            await flushToolCalls()
            return
          }

          const cancelled = result.stopReason === "cancelled"

          // Turn metering is known here — the ACP prompt has settled. Read it
          // ONCE: this credit entry is the single source for both the
          // part-level metadata below and the finish-event mirror. Skipped on
          // cancel, where metering would be absent or stale (kiro-cli reports
          // it at turn end).
          const metadata = cancelled ? undefined : this.client.getMetadata(sessionId)
          const creditEntry = findCreditEntry(metadata)

          // DUAL EMISSION (deliberate): attach the SAME
          // `{ kiro: { credits, creditsUnit } }` object to BOTH the final
          // text-end AND the reasoning-end (when reasoning occurred):
          // - TEXT: some hosts (e.g. opencode) persist part-level
          //   providerMetadata on the final text part — this is what such
          //   consumers read TODAY via `part.metadata.kiro`.
          // - REASONING: a host's schema may instead keep provider metadata
          //   only on reasoning parts (as opencode does post-migration) and
          //   drop it from text parts — but not every kiro model emits
          //   reasoning, so the reasoning path alone is insufficient and the
          //   text path alone is not future-proof.
          // Both parts carry the same turn total — consumers MUST dedupe per
          // assistant message or they will double count. When credits are
          // unknown (or the turn was cancelled) no `kiro` key is attached.
          const partMetadata = creditsProviderMetadata(creditEntry)

          if (reasoningStarted) {
            writePart({
              type: "reasoning-end",
              id: reasoningId,
              ...(partMetadata ? { providerMetadata: partMetadata } : {}),
            })
          }
          if (textStarted) {
            writePart({
              type: "text-end",
              id: textId,
              ...(partMetadata ? { providerMetadata: partMetadata } : {}),
            })
          }

          if (cancelled) {
            writePart({ type: "error", error: new Error("Request was cancelled by user") })

            removeAbortListener()

            this.pendingTurns.delete(sessionId)
            laneRouter?.unregister(sessionId)
            this.cleanupAfterStream(sessionId)
            streamClosed = true
            try {
              await writeChain
              await writer.close()
            } catch {
              // Already closed
            }
            return
          }

          this.totalCredits += creditEntry?.value ?? 0

          // Finish-event mirror (kept deliberately): some hosts (e.g.
          // opencode) consume finish metadata for cost accounting and DROP it
          // (never persisted), so it is harmless there — while plain AI-SDK
          // consumers (and any host that reads finish metadata) get the full
          // turn picture in one event.
          writePart({
            type: "finish",
            finishReason: mapStopReason(result.stopReason),
            usage: estimateUsage(outputCharCount, metadata?.contextUsagePercentage, this.config.contextWindow ?? 1_000_000),
            providerMetadata: metadata
              ? {
                  kiro: {
                    contextUsagePercentage: metadata.contextUsagePercentage ?? null,
                    turnDurationMs: metadata.turnDurationMs ?? null,
                    credits: creditEntry?.value ?? null,
                    creditsUnit: creditEntry?.unit ?? null,
                  },
                }
              : undefined,
          })

          removeAbortListener()

          this.pendingTurns.delete(sessionId)
          laneRouter?.unregister(sessionId)
          this.cleanupAfterStream(sessionId)
          streamClosed = true
          await writeChain
          await writer.close()
        })
        .catch(async (err: unknown) => {
          this.pendingTurns.delete(sessionId)
          laneRouter?.unregister(sessionId)
          this.cleanupAfterStream(sessionId)

          if (streamClosed) return

          if (debounceTimer) {
            clearTimeout(debounceTimer)
            debounceTimer = null
          }

          if (reasoningStarted) {
            writePart({ type: "reasoning-end", id: reasoningId })
          }
          if (textStarted) {
            writePart({ type: "text-end", id: textId })
          }

          writePart({ type: "error", error: new Error(extractErrorMessage(err)) })

          removeAbortListener()

          streamClosed = true
          try {
            await writeChain
            await writer.close()
          } catch {
            // Already closed
          }
        })
    }

    return { readable, onUpdate, onToolCall, attachPromise }
  }

  // -------------------------------------------------------------------------
  // Fresh prompt flow
  // -------------------------------------------------------------------------

  private async startFreshPrompt(
    options: LanguageModelV3CallOptions,
    reset = false,
  ): Promise<LanguageModelV3StreamResult> {
    const session = await this.acquireSession(options.tools)
    const modelChanged = await this.ensureModel(session)
    await this.ensureEffort(session, this.resolveRequestedEffort(options))

    // Kiro resets a custom-agent session to the default mode when the model
    // changes (notably when selecting the `auto` route). Reapply the mode only
    // after model and effort commands, then verify the exact MCP toolset again.
    if (modelChanged) {
      const agentName = this.client.getAgentName()
      if (agentName) {
        const definitions = functionToolDefinitions(options.tools)
        const mapping = buildToolNameMapping(definitions.map((tool) => tool.name))
        const expectedToolNames = definitions
          .map((tool) => mapping.originalToKiro.get(tool.name)!)
          .sort()

        session.modes.currentModeId = ""
        if (expectedToolNames.length > 0) {
          const toolsRevision = this.client.getToolsRevision?.() ?? 0
          await this.ensureSessionMode(session, expectedToolNames, toolsRevision)
        } else {
          await this.client.setMode(session.sessionId, agentName)
          session.modes.currentModeId = agentName
        }
      }
    }

    let promptBlocks: ContentBlock[]

    const hasHistory = reset && options.prompt.some(
      (m) => m.role === "assistant" || m.role === "tool",
    )

    if (hasHistory) {
      const compositeText = formatConversationReplay(options.prompt)
      promptBlocks = [{ type: "text", text: compositeText }]
    } else {
      const { systemPrompt, userParts } = extractPrompt(options.prompt)
      const hasImages = userParts.some((p) => p.type === "image")

      if (hasImages) {
        // Mixed content: send system prompt + user parts as separate blocks
        promptBlocks = systemPrompt
          ? [{ type: "text" as const, text: `<system_instructions>\n${systemPrompt}\n</system_instructions>` }, ...userParts]
          : [...userParts]
      } else {
        // Text-only: combine into single ContentBlock (original behavior kiro-cli expects)
        const userText = userParts.map((p) => p.text ?? "").join("\n")
        const compositeText = systemPrompt
          ? `<system_instructions>\n${systemPrompt}\n</system_instructions>\n\n${userText}`
          : userText
        promptBlocks = [{ type: "text", text: compositeText }]
      }
    }

    const sessionId = session.sessionId

    // Prompt-level abort controller that persists across doStream cycles.
    // Only explicit user cancels fire this — NOT stream-close-for-tool-calls.
    const promptAbort = new AbortController()

    const { readable, onUpdate, onToolCall, attachPromise } = this.createPromptStream({
      sessionId,
      promptAbort,
      initialOutputCharCount: 0,
      streamSegment: 0,
      options,
      savePendingTurn: (state) => {
        this.pendingTurns.set(sessionId, {
          sessionId,
          promptPromise,
          pendingToolCalls: state.pendingToolCalls,
          outputCharCount: state.outputCharCount,
          streamSegment: state.nextSegment,
          promptAbort,
        })
      },
    })

    const laneRouter = this.client.getLaneRouter()
    laneRouter?.register(sessionId, onToolCall)

    // Start the prompt after stream infrastructure is ready so onUpdate
    // can receive synchronous callbacks from client.prompt().
    const promptPromise = this.client.prompt({
      sessionId,
      prompt: promptBlocks,
      onUpdate,
      signal: promptAbort.signal,
    })

    attachPromise(promptPromise)

    const bodyText = promptBlocks
      .map((b) => b.type === "text" ? b.text : `[Image: ${b.mimeType}]`)
      .join("\n")

    return {
      stream: readable,
      request: { body: bodyText },
      response: { headers: {} },
    }
  }

  // -------------------------------------------------------------------------
  // Resumption flow — doStream() called with tool results
  // -------------------------------------------------------------------------

  private async resumeWithToolResults(
    sessionId: string,
    toolResults: Array<{
      toolCallId: string
      toolName: string
      result: string
      content?: IPCContentBlock[]
    }>,
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3StreamResult> {
    const turn = this.pendingTurns.get(sessionId)
    if (!turn) {
      throw new Error(`No pending turn for session ${sessionId}`)
    }

    // Check if any tool results contain images
    const hasImages = toolResults.some(r => r.content?.some(b => b.type === "image"))

    if (!hasImages) {
      // Original path: send tool results with content as-is
      const { readable, onUpdate, onToolCall, attachPromise } = this.createPromptStream({
        sessionId,
        promptAbort: turn.promptAbort,
        initialOutputCharCount: turn.outputCharCount,
        streamSegment: turn.streamSegment,
        options,
        savePendingTurn: (state) => {
          turn.pendingToolCalls = state.pendingToolCalls
          turn.outputCharCount = state.outputCharCount
          turn.streamSegment = state.nextSegment
        },
      })

      const laneRouter = this.client.getLaneRouter()
      laneRouter?.updateHandler(sessionId, onToolCall)

      this.client.setPromptCallback(sessionId, onUpdate)

      for (const result of toolResults) {
        this.sendToolResult(result.toolCallId, result.result, false, result.content)
      }

      attachPromise(turn.promptPromise)

      return {
        stream: readable,
        request: { body: "[tool result resumption]" },
        response: { headers: {} },
      }
    }

    // FUP path: images present — send text-only results, then follow up with images

    // 1. Collect image ContentBlocks from all tool results
    const imageBlocks: ContentBlock[] = []
    for (const result of toolResults) {
      if (result.content) {
        for (const block of result.content) {
          if (block.type === "image" && block.data && block.mimeType) {
            imageBlocks.push({ type: "image", data: block.data, mimeType: block.mimeType })
          }
        }
      }
    }

    // 2. Send text-only tool results so MCP flow completes
    // Only strip content from results that actually have images
    for (const result of toolResults) {
      const hasImageContent = result.content?.some(b => b.type === "image")
      this.sendToolResult(result.toolCallId, result.result, false, hasImageContent ? undefined : result.content)
    }

    // 3. Abort the first response — we don't need the text-only hallucination.
    // This cancels any ongoing generation and frees the session for the follow-up.
    turn.promptAbort.abort()

    // Wait for the prompt promise to settle (it should reject due to abort)
    try {
      await turn.promptPromise
    } catch {
      // Expected: abort causes rejection
    }

    // 4. Clean up the pending turn
    this.pendingTurns.delete(sessionId)

    // 5. Create a NEW prompt stream for the follow-up with images
    const promptAbort = new AbortController()

    // Use a `let` so savePendingTurn can reference followUpPromise
    // (assigned after client.prompt() call below)
    let followUpPromise!: Promise<{ stopReason: string }>

    const { readable, onUpdate, onToolCall, attachPromise } = this.createPromptStream({
      sessionId,
      promptAbort,
      initialOutputCharCount: 0,
      streamSegment: 0,
      options,
      savePendingTurn: (state) => {
        this.pendingTurns.set(sessionId, {
          sessionId,
          promptPromise: followUpPromise,
          pendingToolCalls: state.pendingToolCalls,
          outputCharCount: state.outputCharCount,
          streamSegment: state.nextSegment,
          promptAbort,
        })
      },
    })

    const laneRouter = this.client.getLaneRouter()
    laneRouter?.updateHandler(sessionId, onToolCall)
    this.client.setPromptCallback(sessionId, onUpdate)

    // 6. Send follow-up prompt with images as ContentBlocks

    // Extract the original user request for context in the follow-up
    let lastUserText = ""
    for (const msg of options.prompt) {
      if (msg.role === "user") {
        for (const part of msg.content) {
          if (part.type === "text") {
            lastUserText = part.text
          }
        }
      }
    }

    // Build tool context: which tools returned images
    const imageToolNames = toolResults
      .filter(r => r.content?.some(b => b.type === "image"))
      .map(r => r.toolName)
    const toolContext = imageToolNames.length === 1
      ? `the ${imageToolNames[0]} tool`
      : `the following tools: ${imageToolNames.join(", ")}`

    const followUpBlocks: ContentBlock[] = [
      { type: "text", text: lastUserText
        ? `The user asked: "${lastUserText}"\nYou called ${toolContext} which returned these images. Answer the user's original request based on the images:`
        : `You called ${toolContext} which returned these images. Describe and analyze them:` },
      ...imageBlocks,
    ]

    followUpPromise = this.client.prompt({
      sessionId,
      prompt: followUpBlocks,
      onUpdate,
      signal: promptAbort.signal,
    })

    attachPromise(followUpPromise)

    return {
      stream: readable,
      request: { body: "[tool result resumption with FUP images]" },
      response: { headers: {} },
    }
  }

  // -------------------------------------------------------------------------
  // Tool result delivery via IPC
  // -------------------------------------------------------------------------

  private sendToolResult(
    callId: string,
    result: string,
    isError: boolean,
    content?: IPCContentBlock[],
  ): void {
    const ipcServer = this.client.getIPCServer()
    if (!ipcServer) {
      throw new Error("IPC server not available for sending tool result")
    }

    ipcServer.resolveToolResult({ callId, result, isError, ...(content ? { content } : {}) })
  }

  // -------------------------------------------------------------------------
  // LanguageModelV3 — doGenerate
  // -------------------------------------------------------------------------

  async doGenerate(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3GenerateResult> {
    // Intercept pre-step applied here (not via this.doStream) so it runs
    // exactly once per public call — the inner this.doStream call must not
    // re-run the intercept.
    const result = await this.doStreamInner(this.interceptOptions(options))

    const content: LanguageModelV3Content[] = []
    const textParts: string[] = []
    const reasoningParts: string[] = []
    const toolInputs = new Map<string, { name: string; input: string }>()
    let finishReason: LanguageModelV3FinishReason = { unified: "other", raw: undefined }
    let usage: LanguageModelV3Usage = emptyUsage()
    let providerMetadata: SharedV3ProviderMetadata | undefined

    // Mirror the stream's part-level provider metadata (credits dual
    // emission) onto the corresponding result content parts.
    const flushText = (partMetadata?: SharedV3ProviderMetadata): void => {
      if (textParts.length > 0) {
        content.push({
          type: "text",
          text: textParts.join(""),
          ...(partMetadata ? { providerMetadata: partMetadata } : {}),
        })
        textParts.length = 0
      }
    }

    const flushReasoning = (partMetadata?: SharedV3ProviderMetadata): void => {
      if (reasoningParts.length > 0) {
        content.push({
          type: "reasoning",
          text: reasoningParts.join(""),
          ...(partMetadata ? { providerMetadata: partMetadata } : {}),
        })
        reasoningParts.length = 0
      }
    }

    const reader = result.stream.getReader()

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      switch (value.type) {
        case "text-delta":
          textParts.push(value.delta)
          break

        case "text-end":
          flushText(value.providerMetadata)
          break

        case "reasoning-delta":
          reasoningParts.push(value.delta)
          break

        case "reasoning-end":
          flushReasoning(value.providerMetadata)
          break

        case "tool-input-start":
          flushText()
          flushReasoning()
          toolInputs.set(value.id, { name: value.toolName, input: "" })
          break

        case "tool-input-delta": {
          const tool = toolInputs.get(value.id)
          if (tool) tool.input += value.delta
          break
        }

        case "tool-call": {
          const tool = toolInputs.get(value.toolCallId)
          if (tool) {
            content.push({
              type: "tool-call",
              toolCallId: value.toolCallId,
              toolName: tool.name,
              input: tool.input,
            })
          }
          break
        }

        case "finish":
          finishReason = value.finishReason
          usage = value.usage
          providerMetadata = value.providerMetadata
          break
      }
    }

    flushText()
    flushReasoning()

    return {
      content,
      finishReason,
      usage,
      ...(providerMetadata ? { providerMetadata } : {}),
      warnings: [],
      request: result.request,
      response: {
        headers: result.response?.headers,
      },
    }
  }
}
