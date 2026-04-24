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
} from "@ai-sdk/provider"
import { readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs"
import { randomBytes } from "node:crypto"
import type { ACPClient, ACPSession, SessionUpdate, ContentBlock } from "./acp-client"
import { persistSession, loadPersistedSession, clearPersistedSession } from "./session-storage"
import type { MCPToolDefinition, MCPToolsFile } from "./mcp-bridge-tools"
import type { IPCContentBlock, PendingToolCall } from "./ipc-server"
import type { LaneRouter } from "./lane-router"

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
function parseToolCallNotification(update: Record<string, unknown>): {
  toolCallId: string | undefined
  toolName: string | undefined
  args: Record<string, unknown>
} {
  const toolCallId = (update.toolCallId as string | undefined)
    ?? (update.callId as string | undefined)
  const rawInput = update.rawInput as Record<string, unknown> | undefined

  let toolName: string | undefined
  const title = update.title as string | undefined
  if (title) {
    const match = title.match(/\/([^/]+)$/)
    if (match) {
      toolName = match[1]
    }
  }

  if (!toolName && typeof update.toolName === "string") {
    toolName = update.toolName
  }
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
// Error message extraction
// ---------------------------------------------------------------------------

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
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
  private initPromise: Promise<void> | null = null
  private totalCredits = 0
  private currentAffinityId: string | undefined

  /**
   * Per-session tools file paths. Each ACP session gets its own file
   * so concurrent sessions don't overwrite each other's tool definitions.
   */
  private sessionToolsFiles = new Map<string, { filePath: string; toolNames: string }>()

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
    if (this.client.isRunning()) return

    if (this.initPromise) {
      await this.initPromise
      if (this.client.isRunning()) return
      // Client died after init succeeded — clear and reinitialize
      this.initPromise = null
    }

    this.initPromise = this.client.start(toolsFilePath).then(() => {})

    try {
      await this.initPromise
    } catch (err) {
      this.initPromise = null
      throw err
    }
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

    if (toolsFilePath && tools && tools.length > 0) {
      this.ensureToolsFileReady(toolsFilePath, tools)
    }

    // Try loading an existing session (affinity-based)
    if (this.currentAffinityId) {
      if (this.config.sessionId) {
        try {
          const loaded = await this.client.loadSession(this.config.sessionId)
          const sessionId = loaded.sessionId || this.config.sessionId
          if (!loaded.sessionId) loaded.sessionId = sessionId
          await this.ensureSessionMode(loaded)
          if (this.currentModelId === null) {
            this.currentModelId = loaded.models.currentModelId
          }
          if (toolsFilePath) {
            this.sessionToolsFiles.set(sessionId, { filePath: toolsFilePath, toolNames })
          }
          persistSession(this.client.getCwd(), sessionId, this.currentAffinityId)
          return loaded
        } catch (err) {
          // Fall through to persisted session or create new
        }
      }

      const persisted = loadPersistedSession(this.client.getCwd(), this.currentAffinityId)
      if (persisted) {
        try {
          const session = await this.client.loadSession(persisted.kiroSessionId)
          const sessionId = session.sessionId || persisted.kiroSessionId
          if (!session.sessionId) session.sessionId = sessionId
          if (session) {
            await this.ensureSessionMode(session)
            if (this.currentModelId === null) {
              this.currentModelId = session.models?.currentModelId ?? null
            }
            if (toolsFilePath) {
              this.sessionToolsFiles.set(sessionId, { filePath: toolsFilePath, toolNames })
            }
            persistSession(this.client.getCwd(), sessionId, this.currentAffinityId)
            return session
          }
        } catch (err: unknown) {
          // Fall through to create new session
        }
      }
    }

    // Create a new session with this stream's tools file path.
    // createSessionWithToolsPath() atomically rewrites the agent config
    // before calling session/new.
    const session = toolsFilePath
      ? await this.client.createSessionWithToolsPath(toolsFilePath)
      : await this.client.createSession()
    await this.ensureSessionMode(session)
    if (this.currentModelId === null) {
      this.currentModelId = session.models.currentModelId
    }

    if (toolsFilePath) {
      this.sessionToolsFiles.set(session.sessionId, { filePath: toolsFilePath, toolNames })
    }

    if (this.currentAffinityId) {
      persistSession(this.client.getCwd(), session.sessionId, this.currentAffinityId)
    }

    return session
  }

  /**
   * Clean up after a doStream() lifecycle completes.
   *
   * With affinity: persist mapping, keep kiro session alive, remove tools file.
   * Without affinity: full cleanup (one-shot session).
   */
  private cleanupAfterStream(sessionId: string): void {
    if (this.currentAffinityId) {
      persistSession(this.client.getCwd(), sessionId, this.currentAffinityId)
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
  private async ensureSessionMode(session: ACPSession): Promise<void> {
    const agentName = this.client.getAgentName()
    if (!agentName) return

    if (session.modes.currentModeId !== agentName) {
      await this.client.setMode(session.sessionId, agentName)
      session.modes.currentModeId = agentName
      await this.client.waitForToolsReady({ timeoutMs: 5000 })
    }
  }

  /** Switch model on a session if the requested modelId differs. */
  private async ensureModel(session: ACPSession): Promise<void> {
    if (this.currentModelId === this.modelId) return

    await this.client.setModel(session.sessionId, this.modelId)
    this.currentModelId = this.modelId
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
    const newTools: MCPToolDefinition[] = tools
      .filter((tool): tool is LanguageModelV3FunctionTool => tool.type === "function")
      .map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
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
    const tmpPath = toolsFilePath + ".tmp"
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
      const tmpPath = toolsFilePath + ".tmp"
      writeFileSync(tmpPath, JSON.stringify(parsed, null, 2), { mode: 0o600 })
      renameSync(tmpPath, toolsFilePath)
    } catch {
      // File doesn't exist or is invalid — will be written on next writeToolsToFile()
    }
  }

  /**
   * Ensure tools file has executable tool definitions and IPC wiring.
   *
   * If file contents are stale/incomplete, attempts one in-place repair by
   * rewriting tools + IPC fields, then validates again.
   */
  private ensureToolsFileReady(
    toolsFilePath: string,
    tools: Array<LanguageModelV3FunctionTool | LanguageModelV3ProviderTool>,
  ): void {
    const validate = (): { ok: boolean; reason?: string } => {
      try {
        const raw = readFileSync(toolsFilePath, "utf-8")
        const parsed = JSON.parse(raw) as MCPToolsFile

        const expectedNames = tools
          .filter((tool): tool is LanguageModelV3FunctionTool => tool.type === "function")
          .map((tool) => tool.name)

        const actualNames = new Set((parsed.tools ?? []).map((tool) => tool.name))
        const missing = expectedNames.filter((name) => !actualNames.has(name))

        if (missing.length > 0) {
          return { ok: false, reason: `missing tools: ${missing.join(", ")}` }
        }

        const ipcPort = this.client.getIpcPort()
        if (ipcPort != null && parsed.ipcPort !== ipcPort) {
          return { ok: false, reason: "ipcPort not injected" }
        }

        const ipcSecret = this.client.getIpcSecret()
        if (ipcSecret && parsed.ipcSecret !== ipcSecret) {
          return { ok: false, reason: "ipcSecret not injected" }
        }

        return { ok: true }
      } catch {
        return { ok: false, reason: "tools file unreadable" }
      }
    }

    const first = validate()
    if (first.ok) return

    this.writeToolsToFile(toolsFilePath, tools)
    this.ensureIpcPortInToolsFile(toolsFilePath)

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

            // Handle deprecated "media" type (opencode sends this format)
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
    const affinityId = typeof options.headers?.["x-session-affinity"] === "string"
      ? options.headers["x-session-affinity"]
      : undefined
    this.setAffinityId(affinityId)

    const isChild = typeof options.headers?.["x-parent-session-id"] === "string"
    const hasTools = (options.tools ?? []).length > 0

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
  // Subagent isolation — separate kiro-cli process per subagent
  // -------------------------------------------------------------------------

  private static readonly SUB_CLIENT_IDLE_MS = 180_000

  /**
   * Route a subagent doStream() call to an isolated KiroACPLanguageModel
   * backed by its own ACPClient (separate kiro-cli process).
   *
   * The isolated client is reused across turns for the same affinityId
   * (tool call → tool result → continuation) and cleaned up after 60s idle.
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
      bufferedToolCalls.push(pendingCall)

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

          if (reasoningStarted) {
            writePart({ type: "reasoning-end", id: reasoningId })
          }
          if (textStarted) {
            writePart({ type: "text-end", id: textId })
          }

          if (result.stopReason === "cancelled") {
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

          const metadata = this.client.getMetadata(sessionId)
          const turnCredits =
            metadata?.meteringUsage?.find((m) => m.unit === "credit")?.value ?? 0
          this.totalCredits += turnCredits

          writePart({
            type: "finish",
            finishReason: mapStopReason(result.stopReason),
            usage: estimateUsage(outputCharCount, metadata?.contextUsagePercentage, this.config.contextWindow ?? 1_000_000),
            providerMetadata: metadata
              ? {
                  kiro: {
                    contextUsagePercentage: metadata.contextUsagePercentage ?? null,
                    turnDurationMs: metadata.turnDurationMs ?? null,
                    credits: metadata.meteringUsage?.find((m) => m.unit === "credit")?.value ?? null,
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
    await this.ensureModel(session)

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
    const result = await this.doStream(options)

    const content: LanguageModelV3Content[] = []
    const textParts: string[] = []
    const reasoningParts: string[] = []
    const toolInputs = new Map<string, { name: string; input: string }>()
    let finishReason: LanguageModelV3FinishReason = { unified: "other", raw: undefined }
    let usage: LanguageModelV3Usage = emptyUsage()

    const flushText = (): void => {
      if (textParts.length > 0) {
        content.push({ type: "text", text: textParts.join("") })
        textParts.length = 0
      }
    }

    const flushReasoning = (): void => {
      if (reasoningParts.length > 0) {
        content.push({ type: "reasoning", text: reasoningParts.join("") })
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
          flushText()
          break

        case "reasoning-delta":
          reasoningParts.push(value.delta)
          break

        case "reasoning-end":
          flushReasoning()
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
          break
      }
    }

    flushText()
    flushReasoning()

    return {
      content,
      finishReason,
      usage,
      warnings: [],
      request: result.request,
      response: {
        headers: result.response?.headers,
      },
    }
  }
}
