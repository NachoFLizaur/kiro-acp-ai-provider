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
import { readFileSync, writeFileSync, unlinkSync } from "node:fs"
import { randomBytes } from "node:crypto"
import type { ACPClient, ACPSession, SessionUpdate } from "./acp-client"
import { persistSession, loadPersistedSession } from "./session-storage"
import type { MCPToolDefinition, MCPToolsFile } from "./mcp-bridge-tools"
import type { PendingToolCall } from "./ipc-server"
import type { LaneRouter } from "./lane-router"

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
  const toolCallId = update.toolCallId as string | undefined
  const rawInput = update.rawInput as Record<string, unknown> | undefined

  let toolName: string | undefined
  const title = update.title as string | undefined
  if (title) {
    const match = title.match(/\/([^/]+)$/)
    if (match) {
      toolName = match[1]
    }
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

/**
 * Extract system prompt and latest user message from a LanguageModelV3Prompt.
 *
 * Assistant and tool messages are skipped — kiro-cli's ACP session maintains
 * its own conversation history. Including them would duplicate every turn.
 */
function extractPrompt(prompt: LanguageModelV3Prompt): {
  systemPrompt: string | undefined
  userMessage: string
} {
  const systemParts: string[] = []
  let lastUserMessage = ""

  for (const message of prompt) {
    if (message.role === "system") {
      systemParts.push(message.content)
    } else if (message.role === "user") {
      const parts: string[] = []
      for (const part of message.content) {
        if (part.type === "text") {
          parts.push(part.text)
        }
      }
      lastUserMessage = parts.join("\n")
    }
  }

  const systemPrompt = systemParts.length > 0 ? systemParts.join("\n\n") : undefined

  return {
    systemPrompt,
    userMessage: lastUserMessage,
  }
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
      return
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
      this.cleanupSessionToolsFile(sessionId)
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
      await this.client.waitForToolsReady({ timeoutMs: 3000 })
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
    const toolsData: MCPToolsFile = {
      tools: newTools,
      cwd: this.client.getCwd(),
      ...(ipcPort != null ? { ipcPort } : {}),
    }
    writeFileSync(toolsFilePath, JSON.stringify(toolsData, null, 2))
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
      if (parsed.ipcPort === ipcPort) return

      parsed.ipcPort = ipcPort
      writeFileSync(toolsFilePath, JSON.stringify(parsed, null, 2))
    } catch {
      // File doesn't exist or is invalid — will be written on next writeToolsToFile()
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
  }> {
    const results: Array<{ toolCallId: string; toolName: string; result: string }> = []

    for (const message of prompt) {
      if (message.role === "tool") {
        for (const part of message.content) {
          if (part.type === "tool-result") {
            const output = part.output
            const resultText = output.type === "text"
              ? output.value
              : JSON.stringify(output)
            results.push({
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              result: resultText,
            })
          }
        }
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

    const toolResults = this.extractToolResults(options.prompt)

    if (toolResults.length > 0) {
      const pendingEntry = this.findPendingTurnForResults(toolResults)
      if (pendingEntry) {
        return this.resumeWithToolResults(pendingEntry.sessionId, toolResults, options)
      }
    }

    return this.startFreshPrompt(options)
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
  // Fresh prompt flow
  // -------------------------------------------------------------------------

  private async startFreshPrompt(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3StreamResult> {
    const session = await this.acquireSession(options.tools)
    await this.ensureModel(session)

    const { systemPrompt, userMessage } = extractPrompt(options.prompt)

    const compositeText = systemPrompt
      ? `<system_instructions>\n${systemPrompt}\n</system_instructions>\n\n${userMessage}`
      : userMessage

    const sessionId = session.sessionId

    let textStarted = false
    let reasoningStarted = false
    let outputCharCount = 0
    let streamClosed = false
    const textId = "txt-0"
    const reasoningId = "reasoning-0"

    const { readable, writable } = new TransformStream<LanguageModelV3StreamPart>()
    const writer = writable.getWriter()

    const writePart = async (part: LanguageModelV3StreamPart): Promise<void> => {
      if (streamClosed) return
      try {
        await writer.write(part)
      } catch {
        // Stream closed by consumer
      }
    }

    let bufferedToolCalls: PendingToolCall[] = []
    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    const flushToolCalls = async (): Promise<void> => {
      if (streamClosed || bufferedToolCalls.length === 0) return

      if (reasoningStarted) {
        reasoningStarted = false
        await writePart({ type: "reasoning-end", id: reasoningId })
      }
      if (textStarted) {
        textStarted = false
        await writePart({ type: "text-end", id: textId })
      }

      for (const call of bufferedToolCalls) {
        const argsJson = JSON.stringify(call.args)
        await writePart({ type: "tool-input-start", id: call.callId, toolName: call.toolName })
        await writePart({ type: "tool-input-delta", id: call.callId, delta: argsJson })
        await writePart({ type: "tool-input-end", id: call.callId })
        await writePart({
          type: "tool-call",
          toolCallId: call.callId,
          toolName: call.toolName,
          input: argsJson,
        })
      }

      this.pendingTurns.set(sessionId, {
        sessionId,
        promptPromise,
        pendingToolCalls: new Map(bufferedToolCalls.map(c => [c.callId, c])),
        outputCharCount,
        streamSegment: 1,
        promptAbort,
      })

      const metadata = this.client.getMetadata(sessionId)
      await writePart({
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "tool_use" },
        usage: estimateUsage(outputCharCount, metadata?.contextUsagePercentage, this.config.contextWindow ?? 1_000_000),
      })

      if (options.abortSignal && userAbortHandler) {
        options.abortSignal.removeEventListener("abort", userAbortHandler)
      }

      streamClosed = true
      bufferedToolCalls = []
      await writer.close()
    }

    const laneRouter = this.client.getLaneRouter()
    laneRouter?.register(sessionId, (pendingCall) => {
      bufferedToolCalls.push(pendingCall)

      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        void flushToolCalls()
      }, TOOL_CALL_DEBOUNCE_MS)
    })

    const handleUpdate = (update: SessionUpdate): void => {
      if (streamClosed) return

      const updateType = update.sessionUpdate

      if (updateType === "agent_message_chunk") {
        const text = (update.content as { text?: string } | undefined)?.text
        if (text) {
          outputCharCount += text.length
          if (!textStarted) {
            textStarted = true
            void writePart({ type: "stream-start", warnings: [] })
            void writePart({ type: "text-start", id: textId })
          }
          void writePart({ type: "text-delta", id: textId, delta: text })
        }
      } else if (updateType === "agent_thought_chunk") {
        const text = (update.content as { text?: string } | undefined)?.text
        if (text) {
          if (textStarted) {
            textStarted = false
            void writePart({ type: "text-end", id: textId })
          }
          if (!reasoningStarted) {
            reasoningStarted = true
            void writePart({ type: "stream-start", warnings: [] })
            void writePart({ type: "reasoning-start", id: reasoningId })
          }
          void writePart({ type: "reasoning-delta", id: reasoningId, delta: text })
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

    // Prompt-level abort controller that persists across doStream cycles.
    // Only explicit user cancels fire this — NOT stream-close-for-tool-calls.
    const promptAbort = new AbortController()

    let userAbortHandler: (() => void) | undefined
    if (options.abortSignal) {
      userAbortHandler = () => promptAbort.abort()
      options.abortSignal.addEventListener("abort", userAbortHandler, { once: true })
    }

    const promptPromise = this.client.prompt({
      sessionId,
      prompt: [{ type: "text", text: compositeText }],
      onUpdate: handleUpdate,
      signal: promptAbort.signal,
    })

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
          await writePart({ type: "reasoning-end", id: reasoningId })
        }
        if (textStarted) {
          await writePart({ type: "text-end", id: textId })
        }

        if (result.stopReason === "cancelled") {
          await writePart({ type: "error", error: new Error("Request was cancelled by user") })

          if (options.abortSignal && userAbortHandler) {
            options.abortSignal.removeEventListener("abort", userAbortHandler)
          }

          this.pendingTurns.delete(sessionId)
          laneRouter?.unregister(sessionId)
          this.cleanupAfterStream(sessionId)
          streamClosed = true
          try {
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

        await writePart({
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

        if (options.abortSignal && userAbortHandler) {
          options.abortSignal.removeEventListener("abort", userAbortHandler)
        }

        this.pendingTurns.delete(sessionId)
        laneRouter?.unregister(sessionId)
        this.cleanupAfterStream(sessionId)
        streamClosed = true
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
          await writePart({ type: "reasoning-end", id: reasoningId })
        }
        if (textStarted) {
          await writePart({ type: "text-end", id: textId })
        }

        await writePart({ type: "error", error: err })

        if (options.abortSignal && userAbortHandler) {
          options.abortSignal.removeEventListener("abort", userAbortHandler)
        }

        streamClosed = true
        try {
          await writer.close()
        } catch {
          // Already closed
        }
      })

    return {
      stream: readable,
      request: { body: compositeText },
      response: { headers: {} },
    }
  }

  // -------------------------------------------------------------------------
  // Resumption flow — doStream() called with tool results
  // -------------------------------------------------------------------------

  private async resumeWithToolResults(
    sessionId: string,
    toolResults: Array<{ toolCallId: string; toolName: string; result: string }>,
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3StreamResult> {
    const turn = this.pendingTurns.get(sessionId)
    if (!turn) {
      throw new Error(`No pending turn for session ${sessionId}`)
    }

    let userAbortHandler: (() => void) | undefined
    if (options.abortSignal) {
      userAbortHandler = () => turn.promptAbort.abort()
      options.abortSignal.addEventListener("abort", userAbortHandler, { once: true })
    }

    const { readable, writable } = new TransformStream<LanguageModelV3StreamPart>()
    const writer = writable.getWriter()

    let outputCharCount = turn.outputCharCount
    let textStarted = false
    let reasoningStarted = false
    let streamClosed = false
    const segment = turn.streamSegment
    const textId = `txt-${segment}`
    const reasoningId = `reasoning-${segment}`

    const writePart = async (part: LanguageModelV3StreamPart): Promise<void> => {
      if (streamClosed) return
      try {
        await writer.write(part)
      } catch {
        // Stream closed by consumer
      }
    }

    let bufferedToolCalls: PendingToolCall[] = []
    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    const flushToolCalls = async (): Promise<void> => {
      if (streamClosed || bufferedToolCalls.length === 0) return

      if (reasoningStarted) {
        reasoningStarted = false
        await writePart({ type: "reasoning-end", id: reasoningId })
      }
      if (textStarted) {
        textStarted = false
        await writePart({ type: "text-end", id: textId })
      }

      for (const call of bufferedToolCalls) {
        const argsJson = JSON.stringify(call.args)
        await writePart({ type: "tool-input-start", id: call.callId, toolName: call.toolName })
        await writePart({ type: "tool-input-delta", id: call.callId, delta: argsJson })
        await writePart({ type: "tool-input-end", id: call.callId })
        await writePart({
          type: "tool-call",
          toolCallId: call.callId,
          toolName: call.toolName,
          input: argsJson,
        })
      }

      turn.pendingToolCalls = new Map(bufferedToolCalls.map(c => [c.callId, c]))
      turn.outputCharCount = outputCharCount
      turn.streamSegment = segment + 1

      const metadata = this.client.getMetadata(sessionId)
      await writePart({
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "tool_use" },
        usage: estimateUsage(outputCharCount, metadata?.contextUsagePercentage, this.config.contextWindow ?? 1_000_000),
      })

      if (options.abortSignal && userAbortHandler) {
        options.abortSignal.removeEventListener("abort", userAbortHandler)
      }

      streamClosed = true
      bufferedToolCalls = []
      await writer.close()
    }

    const laneRouter = this.client.getLaneRouter()
    laneRouter?.updateHandler(sessionId, (pendingCall) => {
      bufferedToolCalls.push(pendingCall)

      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        void flushToolCalls()
      }, TOOL_CALL_DEBOUNCE_MS)
    })

    const handleUpdate = (update: SessionUpdate): void => {
      if (streamClosed) return

      const updateType = update.sessionUpdate

      if (updateType === "agent_message_chunk") {
        const text = (update.content as { text?: string } | undefined)?.text
        if (text) {
          outputCharCount += text.length
          if (!textStarted) {
            textStarted = true
            void writePart({ type: "stream-start", warnings: [] })
            void writePart({ type: "text-start", id: textId })
          }
          void writePart({ type: "text-delta", id: textId, delta: text })
        }
      } else if (updateType === "agent_thought_chunk") {
        const text = (update.content as { text?: string } | undefined)?.text
        if (text) {
          if (textStarted) {
            textStarted = false
            void writePart({ type: "text-end", id: textId })
          }
          if (!reasoningStarted) {
            reasoningStarted = true
            void writePart({ type: "stream-start", warnings: [] })
            void writePart({ type: "reasoning-start", id: reasoningId })
          }
          void writePart({ type: "reasoning-delta", id: reasoningId, delta: text })
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

    this.client.setPromptCallback(sessionId, handleUpdate)

    for (const result of toolResults) {
      this.sendToolResult(result.toolCallId, result.result, false)
    }

    turn.promptPromise
      .then(async (result) => {
        if (streamClosed) return

        if (debounceTimer) {
          clearTimeout(debounceTimer)
          debounceTimer = null
        }

        if (bufferedToolCalls.length > 0) {
          await flushToolCalls()
          return
        }

        if (reasoningStarted) await writePart({ type: "reasoning-end", id: reasoningId })
        if (textStarted) await writePart({ type: "text-end", id: textId })

        if (result.stopReason === "cancelled") {
          await writePart({ type: "error", error: new Error("Request was cancelled by user") })

          if (options.abortSignal && userAbortHandler) {
            options.abortSignal.removeEventListener("abort", userAbortHandler)
          }

          this.pendingTurns.delete(sessionId)
          laneRouter?.unregister(sessionId)
          this.cleanupAfterStream(sessionId)
          streamClosed = true
          try {
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

        await writePart({
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

        if (options.abortSignal && userAbortHandler) {
          options.abortSignal.removeEventListener("abort", userAbortHandler)
        }

        this.pendingTurns.delete(sessionId)
        laneRouter?.unregister(sessionId)
        this.cleanupAfterStream(sessionId)
        streamClosed = true
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

        if (reasoningStarted) await writePart({ type: "reasoning-end", id: reasoningId })
        if (textStarted) await writePart({ type: "text-end", id: textId })
        await writePart({ type: "error", error: err })

        if (options.abortSignal && userAbortHandler) {
          options.abortSignal.removeEventListener("abort", userAbortHandler)
        }

        streamClosed = true
        try {
          await writer.close()
        } catch {
          // Already closed
        }
      })

    return {
      stream: readable,
      request: { body: "[tool result resumption]" },
      response: { headers: {} },
    }
  }

  // -------------------------------------------------------------------------
  // Tool result delivery via IPC
  // -------------------------------------------------------------------------

  private sendToolResult(callId: string, result: string, isError: boolean): void {
    const ipcServer = this.client.getIPCServer()
    if (!ipcServer) {
      throw new Error("IPC server not available for sending tool result")
    }

    ipcServer.resolveToolResult({ callId, result, isError })
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
