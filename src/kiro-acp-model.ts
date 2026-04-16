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
import { readFileSync, writeFileSync } from "node:fs"
import type { ACPClient, ACPSession, SessionUpdate } from "./acp-client"
import type { MCPToolDefinition, MCPToolsFile } from "./mcp-bridge-tools"
import type { PendingToolCall } from "./ipc-server"
import type { LaneRouter } from "./lane-router"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** State for an ongoing kiro-cli prompt that is paused waiting for tool results. */
interface PendingTurnState {
  /** The ACP session this prompt is running on. */
  sessionId: string
  /** The promise from client.prompt() — still pending while kiro is blocked. */
  promptPromise: Promise<{ stopReason: string }>
  /** Pending tool calls waiting for results. Map<callId, PendingToolCall>. */
  pendingToolCalls: Map<string, PendingToolCall>
  /** Character count for usage estimation (accumulated across the turn). */
  outputCharCount: number
  /** Incremented for unique text/reasoning IDs across stream segments. */
  streamSegment: number
}

/** Configuration for creating a KiroACPLanguageModel. */
export interface KiroACPModelConfig {
  /** The ACP client instance (shared across models). */
  client: ACPClient
  /** If provided, try to load this existing session instead of creating new. */
  sessionId?: string
  /** Model's max context window in tokens (from models.dev). Default: 1_000_000. */
  contextWindow?: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract tool name and clean args from an ACP tool_call notification.
 *
 * ACP tool_call notifications don't have a `name` property directly.
 * The tool name is embedded in the `title` field as "Running: @<source>/<name>".
 * The `rawInput` may contain internal kiro-cli fields (like `__tool_use_purpose`)
 * that aren't part of the actual tool arguments and must be stripped for
 * correlation matching against IPC calls.
 */
function parseToolCallNotification(update: Record<string, unknown>): {
  toolCallId: string | undefined
  toolName: string | undefined
  args: Record<string, unknown>
} {
  const toolCallId = update.toolCallId as string | undefined
  const rawInput = update.rawInput as Record<string, unknown> | undefined

  // Extract tool name from title: "Running: @opencode-tools/bash" → "bash"
  let toolName: string | undefined
  const title = update.title as string | undefined
  if (title) {
    const match = title.match(/\/([^/]+)$/)
    if (match) {
      toolName = match[1]
    }
  }

  // Strip internal kiro-cli fields from args for clean correlation matching
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

/** Create an empty usage object — used as a fallback when no estimation data is available. */
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
 * - Output tokens from streamed text (~1 token per 4 characters)
 * - Total tokens from contextUsagePercentage (0-100 scale) × context window
 * - Input tokens = total - output (includes kiro's system prompt, tools, history)
 *
 * The context percentage represents total context window usage including kiro's
 * overhead (system prompt, 13+ built-in tools, agent instructions, conversation
 * history, and the model's response). This is honest — it shows real usage.
 *
 * contextUsagePercentage is on a 0-100 scale (e.g., 1.14 means 1.14%).
 */
function estimateUsage(
  outputCharCount: number,
  contextPercentage: number | undefined,
  contextWindow: number,
): LanguageModelV3Usage {
  const output = Math.round(outputCharCount / 4)

  // contextUsagePercentage is on a 0-100 scale (e.g., 1.14 = 1.14%)
  const total = contextPercentage != null
    ? Math.round((contextPercentage / 100) * contextWindow)
    : undefined

  // Input = total - output (what went IN to the model)
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

/** Map an ACP stop reason string to a LanguageModelV3FinishReason. */
function mapStopReason(stopReason: string): LanguageModelV3FinishReason {
  switch (stopReason) {
    case "end_turn":
      return { unified: "stop", raw: stopReason }
    case "max_tokens":
      return { unified: "length", raw: stopReason }
    case "tool_use":
      return { unified: "tool-calls", raw: stopReason }
    case "cancelled":
      return { unified: "stop", raw: stopReason }
    case "content_filter":
      return { unified: "content-filter", raw: stopReason }
    default:
      return { unified: "other", raw: stopReason }
  }
}

/**
 * Extract the system prompt and the latest user message from a LanguageModelV3Prompt.
 *
 * The AI SDK prompt is an array of messages with roles. We extract:
 * - All system messages → concatenated into a single system prompt
 * - The LAST user message → only its text parts
 *
 * Assistant and tool messages are intentionally skipped because kiro-cli's
 * ACP session maintains its own conversation history. Including them would
 * cause the model to see every previous turn twice — once from kiro's session
 * state and once from the embedded prompt.
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
      // Keep overwriting — we want the LAST user message
      const parts: string[] = []
      for (const part of message.content) {
        if (part.type === "text") {
          parts.push(part.text)
        }
        // File parts are not supported via ACP text prompt — skip
      }
      lastUserMessage = parts.join("\n")
    }
    // Skip assistant and tool messages — kiro-cli has them in its session
  }

  return {
    systemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
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
 * LanguageModelV3 implementation that delegates to kiro-cli via the
 * Agent Client Protocol (ACP).
 *
 * Key design decisions:
 * - ACP sessions are pooled: when a `doStream()` call arrives while the
 *   current session is busy (e.g. parent waiting for a tool result while
 *   a subagent fires a nested prompt), a new session is created
 *   automatically. This avoids the deadlock that kiro-cli's single-
 *   session prompt lock would otherwise cause.
 * - System prompts from the AI SDK are injected into the user message
 *   wrapped in `<system_instructions>` tags.
 * - Tool calls are emitted as standard AI SDK tool-call parts (no
 *   providerExecuted flag). The harness executes tools and calls
 *   doStream() again with results.
 * - Model switching is done via `_kiro.dev/commands/execute`.
 */
export class KiroACPLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const
  readonly provider = "kiro-acp"
  readonly modelId: string
  readonly defaultObjectGenerationMode = undefined
  readonly supportedUrls: Record<string, RegExp[]> = {}

  private readonly client: ACPClient
  private readonly config: KiroACPModelConfig
  /** All ACP sessions created by this model instance. */
  private sessions: ACPSession[] = []
  /** Session IDs that currently have an in-flight prompt. */
  private busySessions = new Set<string>()
  private currentModelId: string | null = null
  private initPromise: Promise<void> | null = null
  private totalCredits = 0
  /** Tracks the last set of tool names written, for change detection. */
  private lastToolNames = ""

  /**
   * Per-session state for ongoing kiro-cli prompts paused waiting for tool results.
   * Keyed by ACP sessionId so concurrent sessions don't clobber each other.
   * When a tool call arrives via IPC, we close the stream and store state here.
   * The next doStream() call (with tool results) uses this to resume.
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

  /** Get total credits consumed across all turns in this model's session. */
  getTotalCredits(): number {
    return this.totalCredits
  }

  // -------------------------------------------------------------------------
  // Session pool
  // -------------------------------------------------------------------------

  /**
   * Ensure the ACP client is started. Safe to call multiple times — only
   * initializes once. If initialization fails, subsequent calls will retry.
   */
  private async ensureClient(): Promise<void> {
    if (this.client.isRunning()) return

    if (this.initPromise) {
      await this.initPromise
      return
    }

    this.initPromise = this.client.start().then(() => {})

    try {
      await this.initPromise
    } catch (err) {
      this.initPromise = null
      throw err
    }
  }

  /**
   * Acquire a free ACP session from the pool, or create a new one.
   *
   * When tools are provided, they are written to the tools file BEFORE
   * starting the client. This ensures kiro-cli's MCP bridge sees the full
   * tool set on its first `tools/list` query, avoiding the race condition
   * where the system prompt is built with only default tools.
   *
   * When a `doStream()` call arrives while the current session is busy
   * (e.g. parent waiting for a tool result while a subagent fires a
   * nested prompt), a new session is created automatically. This avoids
   * the deadlock that kiro-cli's single-session prompt lock would cause.
   *
   * For the very first session, if `config.sessionId` was provided we
   * attempt to load it via `session/load`. If that fails we fall through
   * to creating a fresh session.
   */
  private async acquireSession(
    tools?: Array<LanguageModelV3FunctionTool | LanguageModelV3ProviderTool>,
  ): Promise<ACPSession> {
    // Write tools BEFORE starting the client so the MCP bridge has them
    // from the very first `tools/list` query.
    if (tools && tools.length > 0) {
      const toolsChanged = this.writeToolsFile(tools)

      if (this.client.isRunning() && toolsChanged) {
        // Mid-session tool change — wait for kiro-cli to process the
        // tools/list_changed notification and send _kiro.dev/commands/available.
        const toolNames = tools
          .filter((t): t is LanguageModelV3FunctionTool => t.type === "function")
          .map((t) => t.name)
        await this.client.waitForToolsReady({
          timeoutMs: 3000,
          expectedTools: toolNames,
        })
      }
      // If client not running yet, no delay needed — kiro will read on startup
    }

    await this.ensureClient()

    // Find a session that isn't currently in a prompt
    const free = this.sessions.find(s => !this.busySessions.has(s.sessionId))
    if (free) {
      this.busySessions.add(free.sessionId)
      return free
    }

    // No free session — create a new one.
    // For the first session, try loading an existing one if sessionId was provided.
    if (this.sessions.length === 0 && this.config.sessionId) {
      try {
        const loaded = await this.client.loadSession(this.config.sessionId)
        await this.ensureSessionMode(loaded)
        this.sessions.push(loaded)
        this.busySessions.add(loaded.sessionId)
        if (this.currentModelId === null) {
          this.currentModelId = loaded.models.currentModelId
        }
        return loaded
      } catch {
        // Fall through to create new
      }
    }

    const session = await this.client.createSession()
    await this.ensureSessionMode(session)
    this.sessions.push(session)
    this.busySessions.add(session.sessionId)
    if (this.currentModelId === null) {
      this.currentModelId = session.models.currentModelId
    }
    return session
  }

  /**
   * Release a session back to the pool so it can be reused.
   */
  private releaseSession(sessionId: string): void {
    this.busySessions.delete(sessionId)
  }

  /**
   * Ensure a session is in the correct agent mode.
   *
   * When kiro-cli creates a new session via `session/new`, only the first
   * session inherits the `--agent` flag's mode. Subsequent sessions default
   * to `kiro_default`, which uses kiro's built-in tools instead of our MCP
   * bridge tools. This method explicitly sets the mode after session creation
   * or loading to guarantee every session uses the correct agent mode.
   */
  private async ensureSessionMode(session: ACPSession): Promise<void> {
    const agentName = this.client.getAgentName()
    if (!agentName) return

    if (session.modes.currentModeId !== agentName) {
      await this.client.setMode(session.sessionId, agentName)
      session.modes.currentModeId = agentName
      // Wait for kiro-cli to process the mode switch and send
      // _kiro.dev/commands/available with the updated tool set.
      await this.client.waitForToolsReady({ timeoutMs: 3000 })
    }
  }

  /**
   * Switch the model on a specific session if the requested modelId
   * differs from the current one.
   */
  private async ensureModel(session: ACPSession): Promise<void> {
    if (this.currentModelId === this.modelId) return

    await this.client.setModel(session.sessionId, this.modelId)
    this.currentModelId = this.modelId
  }

  // -------------------------------------------------------------------------
  // Session rehydration
  // -------------------------------------------------------------------------

  /** Get the primary (first) ACP session ID (for persistence across restarts). */
  getSessionId(): string | null {
    return this.sessions[0]?.sessionId ?? null
  }

  /**
   * Inject conversation context into the current session.
   * Used when session/load fails and we need to rehydrate from opencode's history.
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
        onUpdate: () => {}, // Consume but ignore the acknowledgment response
      })
    } finally {
      this.releaseSession(session.sessionId)
    }
  }

  // -------------------------------------------------------------------------
  // Dynamic tool synchronization
  // -------------------------------------------------------------------------

  /**
   * Write tool definitions from the AI SDK to the MCP bridge tools file.
   *
   * Converts LanguageModelV3 tool definitions to MCP format and **merges**
   * them with any existing tools in the file. This is critical for multi-
   * session correctness: when a child session writes its subset of tools
   * (e.g. `[bash]`), the main session's tools (e.g. `[task, read, ...]`)
   * must not be evicted. The file always contains the UNION of all active
   * sessions' tools.
   *
   * Tool removal only happens on a clean restart (file recreated from
   * scratch). During a session, tools are never removed — the harness
   * enforces per-agent permissions at execution time.
   *
   * Only function tools are synced — provider tools are skipped since they
   * are handled by the provider itself, not the MCP bridge.
   *
   * @returns `true` if the tools file was actually written (tools changed),
   *          `false` if the tools are the same as last time (no write needed).
   */
  private writeToolsFile(
    tools: Array<LanguageModelV3FunctionTool | LanguageModelV3ProviderTool>,
  ): boolean {
    // Use getOrCreateToolsFilePath so the path exists even before start()
    const toolsFilePath = this.client.getOrCreateToolsFilePath()

    // Convert current session's AI SDK function tools to MCP format
    const newTools: MCPToolDefinition[] = tools
      .filter((tool): tool is LanguageModelV3FunctionTool => tool.type === "function")
      .map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema as MCPToolDefinition["inputSchema"],
      }))

    // Read existing tools from the file and merge (superset / union)
    let existingTools: MCPToolDefinition[] = []
    try {
      const existing = JSON.parse(readFileSync(toolsFilePath, "utf-8")) as MCPToolsFile
      existingTools = existing.tools ?? []
    } catch {
      // File doesn't exist yet or is invalid — start fresh
    }

    // Merge: keep all existing tools, new tools override existing definitions
    const toolMap = new Map<string, MCPToolDefinition>()
    for (const tool of existingTools) toolMap.set(tool.name, tool)
    for (const tool of newTools) toolMap.set(tool.name, tool)
    const mergedTools = Array.from(toolMap.values())

    // Check if the merged set actually changed from what we last wrote
    const mergedNames = mergedTools.map(t => t.name).sort().join(",")
    if (mergedNames === this.lastToolNames) return false
    this.lastToolNames = mergedNames

    // Write to tools file (the bridge watches this and sends list_changed)
    const ipcPort = this.client.getIpcPort()
    const toolsData: MCPToolsFile = {
      tools: mergedTools,
      cwd: this.client.getCwd(),
      ...(ipcPort != null ? { ipcPort } : {}),
    }
    writeFileSync(toolsFilePath, JSON.stringify(toolsData, null, 2))
    return true
  }

  // -------------------------------------------------------------------------
  // Tool result extraction from AI SDK prompt
  // -------------------------------------------------------------------------

  /**
   * Extract tool results from the prompt's `tool` role messages.
   *
   * When the AI SDK calls doStream() with tool results, they appear as
   * messages with `role: "tool"` containing `tool-result` parts.
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
            // AI SDK V3: output is { type: "text", value: string }
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
    // Check for tool results in the prompt
    const toolResults = this.extractToolResults(options.prompt)

    // Find which session has a pending turn matching these tool results
    if (toolResults.length > 0) {
      const pendingEntry = this.findPendingTurnForResults(toolResults)
      if (pendingEntry) {
        return this.resumeWithToolResults(pendingEntry.sessionId, toolResults, options)
      }
    }

    // Fresh prompt — no need to clear other sessions' pending turns
    return this.startFreshPrompt(options)
  }

  // -------------------------------------------------------------------------
  // Pending turn lookup
  // -------------------------------------------------------------------------

  /**
   * Find the pending turn whose tool call IDs match the given tool results.
   * This allows correct routing when multiple sessions have pending turns.
   */
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
    // Pass tools to acquireSession so they're written BEFORE kiro-cli starts.
    // This ensures the MCP bridge sees the full tool set on its first query.
    const session = await this.acquireSession(options.tools)
    await this.ensureModel(session)

    const { systemPrompt, userMessage } = extractPrompt(options.prompt)

    // Build composite prompt: system instructions + user message
    const compositeText = systemPrompt
      ? `<system_instructions>\n${systemPrompt}\n</system_instructions>\n\n${userMessage}`
      : userMessage

    const sessionId = session.sessionId

    // State tracking for stream part generation
    let textStarted = false
    let reasoningStarted = false
    let outputCharCount = 0
    let streamClosed = false
    const textId = "txt-0"
    const reasoningId = "reasoning-0"

    // Create a ReadableStream that maps ACP notifications to LanguageModelV3StreamPart
    const { readable, writable } = new TransformStream<LanguageModelV3StreamPart>()
    const writer = writable.getWriter()

    // Helper to write a part to the stream (swallows errors if stream is closed)
    const writePart = async (part: LanguageModelV3StreamPart): Promise<void> => {
      if (streamClosed) return
      try {
        await writer.write(part)
      } catch {
        // Stream may have been closed by consumer — ignore
      }
    }

    // Buffered tool calls for debouncing parallel calls
    let bufferedToolCalls: PendingToolCall[] = []
    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    // Flush buffered tool calls to the stream and close it
    const flushToolCalls = async (): Promise<void> => {
      if (streamClosed || bufferedToolCalls.length === 0) return

      // Close any open text/reasoning spans
      if (reasoningStarted) {
        reasoningStarted = false
        await writePart({ type: "reasoning-end", id: reasoningId })
      }
      if (textStarted) {
        textStarted = false
        await writePart({ type: "text-end", id: textId })
      }

      // Emit all buffered tool calls
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

      // Store pending state for resumption (keyed by session)
      this.pendingTurns.set(sessionId, {
        sessionId,
        promptPromise,
        pendingToolCalls: new Map(bufferedToolCalls.map(c => [c.callId, c])),
        outputCharCount,
        streamSegment: 1,
      })

      // Emit finish with tool-calls reason and close stream
      const metadata = this.client.getMetadata(sessionId)
      await writePart({
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "tool_use" },
        usage: estimateUsage(outputCharCount, metadata?.contextUsagePercentage, this.config.contextWindow ?? 1_000_000),
      })

      streamClosed = true
      bufferedToolCalls = []
      await writer.close()
    }

    // Register a lane for this session's tool calls
    const laneRouter = this.client.getLaneRouter()
    laneRouter?.register(sessionId, (pendingCall) => {
      bufferedToolCalls.push(pendingCall)

      // Debounce: wait for more tool calls to arrive (parallel calls)
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        void flushToolCalls()
      }, TOOL_CALL_DEBOUNCE_MS)
    })

    // Map ACP session updates to AI SDK stream parts
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
          // Close text if open, start reasoning
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
        // Correlate tool_call notifications with the lane for routing
        const { toolCallId, toolName, args: cleanArgs } = parseToolCallNotification(
          update as Record<string, unknown>,
        )
        if (toolCallId && toolName) {
          laneRouter?.correlate(sessionId, toolCallId, toolName, cleanArgs)
        }
      }
    }

    // Start the ACP prompt (runs in background, may be held by tool calls).
    // No abort signal — the prompt must NOT be cancelled between tool-call
    // cycles. The AI SDK's per-doStream abort signal fires when a stream
    // closes for tool-calls, which would cancel the kiro-cli prompt while
    // it's still waiting for tool results. The prompt runs until kiro
    // finishes or the process is killed (via provider.shutdown()).
    const promptPromise = this.client.prompt({
      sessionId,
      prompt: [{ type: "text", text: compositeText }],
      onUpdate: handleUpdate,
    })

    // If the prompt completes without any tool calls (pure text response)
    promptPromise
      .then(async (result) => {
        if (streamClosed) return

        // Cancel any pending debounce timer
        if (debounceTimer) {
          clearTimeout(debounceTimer)
          debounceTimer = null
        }

        // If there are buffered tool calls that haven't been flushed yet,
        // flush them now (prompt completed during debounce window)
        if (bufferedToolCalls.length > 0) {
          await flushToolCalls()
          return
        }

        // Close any open text/reasoning spans
        if (reasoningStarted) {
          await writePart({ type: "reasoning-end", id: reasoningId })
        }
        if (textStarted) {
          await writePart({ type: "text-end", id: textId })
        }

        // Emit metadata
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

        // Release session BEFORE closing the stream so the next doStream()
        // call (triggered by the consumer reading the finish part) can reuse it.
        this.pendingTurns.delete(sessionId)
        laneRouter?.unregister(sessionId)
        this.releaseSession(sessionId)
        streamClosed = true
        await writer.close()
      })
      .catch(async (err: unknown) => {
        if (streamClosed) return

        // Cancel any pending debounce timer
        if (debounceTimer) {
          clearTimeout(debounceTimer)
          debounceTimer = null
        }

        // Close any open spans before error
        if (reasoningStarted) {
          await writePart({ type: "reasoning-end", id: reasoningId })
        }
        if (textStarted) {
          await writePart({ type: "text-end", id: textId })
        }

        await writePart({ type: "error", error: err })
        this.pendingTurns.delete(sessionId)
        laneRouter?.unregister(sessionId)
        this.releaseSession(sessionId)
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

    // Buffered tool calls for debouncing parallel calls
    let bufferedToolCalls: PendingToolCall[] = []
    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    // Flush buffered tool calls to the stream and close it
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

      // Update pending state for next resumption
      turn.pendingToolCalls = new Map(bufferedToolCalls.map(c => [c.callId, c]))
      turn.outputCharCount = outputCharCount
      turn.streamSegment = segment + 1

      const metadata = this.client.getMetadata(sessionId)
      await writePart({
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "tool_use" },
        usage: estimateUsage(outputCharCount, metadata?.contextUsagePercentage, this.config.contextWindow ?? 1_000_000),
      })

      streamClosed = true
      bufferedToolCalls = []
      await writer.close()
    }

    // Update the lane handler for this session (lane stays registered from startFreshPrompt)
    const laneRouter = this.client.getLaneRouter()
    laneRouter?.updateHandler(sessionId, (pendingCall) => {
      bufferedToolCalls.push(pendingCall)

      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        void flushToolCalls()
      }, TOOL_CALL_DEBOUNCE_MS)
    })

    // Wire up text streaming from the ongoing prompt
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
        // Correlate tool_call notifications with the lane for routing
        const { toolCallId, toolName, args: cleanArgs } = parseToolCallNotification(
          update as Record<string, unknown>,
        )
        if (toolCallId && toolName) {
          laneRouter?.correlate(sessionId, toolCallId, toolName, cleanArgs)
        }
      }
      // tool_call_update notifications are ignored
    }

    // Re-register the update handler for the ongoing prompt
    this.client.setPromptCallback(sessionId, handleUpdate)

    // Send tool results via IPC to unblock the MCP bridge
    for (const result of toolResults) {
      this.sendToolResult(result.toolCallId, result.result, false)
    }

    // The prompt is still running — wait for it to complete or hit another tool call
    turn.promptPromise
      .then(async (result) => {
        if (streamClosed) return

        // Cancel any pending debounce timer
        if (debounceTimer) {
          clearTimeout(debounceTimer)
          debounceTimer = null
        }

        // Flush any buffered tool calls
        if (bufferedToolCalls.length > 0) {
          await flushToolCalls()
          return
        }

        if (reasoningStarted) await writePart({ type: "reasoning-end", id: reasoningId })
        if (textStarted) await writePart({ type: "text-end", id: textId })

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

        this.pendingTurns.delete(sessionId)
        laneRouter?.unregister(sessionId)
        this.releaseSession(sessionId)
        streamClosed = true
        await writer.close()
      })
      .catch(async (err: unknown) => {
        if (streamClosed) return

        if (debounceTimer) {
          clearTimeout(debounceTimer)
          debounceTimer = null
        }

        if (reasoningStarted) await writePart({ type: "reasoning-end", id: reasoningId })
        if (textStarted) await writePart({ type: "text-end", id: textId })
        await writePart({ type: "error", error: err })
        this.pendingTurns.delete(sessionId)
        laneRouter?.unregister(sessionId)
        this.releaseSession(sessionId)
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

    // Call the IPC server's resolveToolResult method directly (same process)
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

    // Flush any remaining text/reasoning
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
