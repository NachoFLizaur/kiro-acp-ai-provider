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
import { writeFileSync } from "node:fs"
import type { ACPClient, ACPSession, SessionUpdate } from "./acp-client"
import type { MCPToolDefinition } from "./mcp-bridge-tools"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

/**
 * Extract the tool name from an ACP session update.
 *
 * ACP's `tool_call` update doesn't carry a top-level `name` field.
 * The tool name is embedded in `update.title` formatted as
 * `"Running: @<server>/<tool>"` or `"Running: <tool>"`.
 * We fall back to `update.name` in case future ACP versions add it.
 */
function extractToolName(update: SessionUpdate): string {
  // Try update.name first (in case future ACP versions add it)
  if (typeof update.name === "string" && update.name) return update.name

  // Parse from title: "Running: @server/toolname" → "toolname"
  const title = update.title as string | undefined
  if (title) {
    const afterPrefix = title.replace(/^Running:\s*/, "")
    const slashIdx = afterPrefix.lastIndexOf("/")
    return slashIdx >= 0 ? afterPrefix.slice(slashIdx + 1) : afterPrefix
  }

  return "unknown_tool"
}

/**
 * Extract a text representation of a tool call output from an ACP session update.
 */
function extractToolOutput(update: SessionUpdate): string {
  // The update may contain output in various shapes
  const output = update.output as string | Record<string, unknown> | undefined
  if (typeof output === "string") return output
  if (output && typeof output === "object") return JSON.stringify(output)

  // Fallback: check for content field
  const content = update.content as { text?: string } | undefined
  if (content?.text) return content.text

  return ""
}

// ---------------------------------------------------------------------------
// KiroACPLanguageModel
// ---------------------------------------------------------------------------

/**
 * LanguageModelV3 implementation that delegates to kiro-cli via the
 * Agent Client Protocol (ACP).
 *
 * Key design decisions:
 * - A single ACP session is created lazily and reused across calls.
 * - System prompts from the AI SDK are injected into the user message
 *   wrapped in `<system_instructions>` tags.
 * - Tool calls executed by kiro-cli are emitted as provider-executed
 *   tool calls with results.
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
  private session: ACPSession | null = null
  private currentModelId: string | null = null
  private initPromise: Promise<void> | null = null
  private promptLock: Promise<unknown> = Promise.resolve()
  private totalCredits = 0

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
  // Session lifecycle
  // -------------------------------------------------------------------------

  /**
   * Ensure the ACP client is started and a session exists.
   * Safe to call multiple times — only initializes once.
   * If initialization fails, subsequent calls will retry.
   *
   * When `config.sessionId` is provided, attempts to load the existing session
   * via `session/load` first. If that fails (e.g. session was cleaned up),
   * falls through to creating a new session.
   */
  private async ensureSession(): Promise<void> {
    if (this.session) return

    // Prevent concurrent initialization — join the existing attempt
    if (this.initPromise) {
      await this.initPromise
      if (!this.session) {
        throw new Error("Session initialization failed")
      }
      return
    }

    this.initPromise = (async () => {
      // Start the client if not already running
      if (!this.client.isRunning()) {
        await this.client.start()
      }

      // Try to load existing session if sessionId was provided
      if (this.config.sessionId) {
        try {
          this.session = await this.client.loadSession(this.config.sessionId)
          this.currentModelId = this.session.models.currentModelId
          return
        } catch {
          // Session load failed — fall through to create new
        }
      }

      // Create a new session
      this.session = await this.client.createSession()
      this.currentModelId = this.session.models.currentModelId
    })()

    try {
      await this.initPromise
    } catch (err) {
      // Reset so next call retries
      this.initPromise = null
      throw err
    }
    // Keep initPromise set on success so concurrent callers can join it
  }

  /**
   * Switch the model if the requested modelId differs from the current one.
   */
  private async ensureModel(): Promise<void> {
    if (this.currentModelId === this.modelId) return

    await this.client.setModel(this.session!.sessionId, this.modelId)
    this.currentModelId = this.modelId
  }

  // -------------------------------------------------------------------------
  // Session rehydration
  // -------------------------------------------------------------------------

  /** Get the current ACP session ID (for persistence across restarts). */
  getSessionId(): string | null {
    return this.session?.sessionId ?? null
  }

  /**
   * Inject conversation context into the current session.
   * Used when session/load fails and we need to rehydrate from opencode's history.
   */
  async injectContext(summary: string): Promise<void> {
    await this.ensureSession()

    await this.client.prompt({
      sessionId: this.session!.sessionId,
      prompt: [{
        type: "text",
        text: `<context_rehydration>\nThe following is a summary of our previous conversation that was interrupted:\n\n${summary}\n\nPlease acknowledge this context and continue from where we left off.\n</context_rehydration>`,
      }],
      onUpdate: () => {}, // Consume but ignore the acknowledgment response
    })
  }

  // -------------------------------------------------------------------------
  // Dynamic tool synchronization
  // -------------------------------------------------------------------------

  /**
   * Synchronize tool definitions from the AI SDK to the MCP bridge.
   *
   * Converts LanguageModelV3 tool definitions to MCP format and writes them
   * to the tools file that the MCP bridge watches. The bridge detects the
   * change and sends `notifications/tools/list_changed` to kiro-cli, which
   * re-queries `tools/list` to get the updated set.
   *
   * Only function tools are synced — provider tools are skipped since they
   * are handled by the provider itself, not the MCP bridge.
   */
  private syncTools(
    tools: Array<LanguageModelV3FunctionTool | LanguageModelV3ProviderTool>,
  ): void {
    const toolsFilePath = this.client.getToolsFilePath()
    if (!toolsFilePath) return // No tools file — agent config not set up

    // Convert AI SDK function tools to MCP format
    const mcpTools: MCPToolDefinition[] = tools
      .filter((tool): tool is LanguageModelV3FunctionTool => tool.type === "function")
      .map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema as MCPToolDefinition["inputSchema"],
      }))

    // Write to tools file (the bridge watches this and sends list_changed)
    const ipcPort = this.client.getIpcPort()
    const toolsData = {
      tools: mcpTools,
      cwd: this.client.getCwd(),
      ...(ipcPort != null ? { ipcPort } : {}),
    }
    writeFileSync(toolsFilePath, JSON.stringify(toolsData, null, 2))
  }

  // -------------------------------------------------------------------------
  // LanguageModelV3 — doStream
  // -------------------------------------------------------------------------

  async doStream(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3StreamResult> {
    // Serialize prompts — ACP sessions don't support concurrent prompts.
    // We wait for any in-flight prompt to finish before starting a new one.
    const previousPrompt = this.promptLock
    let releaseLock: () => void
    this.promptLock = new Promise<void>((resolve) => {
      releaseLock = resolve
    })

    try {
      await previousPrompt
    } catch {
      // Previous prompt failed — that's fine, we can proceed
    }

    await this.ensureSession()
    await this.ensureModel()

    // Sync dynamic tools to the MCP bridge before sending the prompt.
    // opencode's permission system filters tools per-turn, so the set may
    // change between calls. The bridge watches the file and notifies kiro-cli.
    if (options.tools && options.tools.length > 0) {
      this.syncTools(options.tools)
    }

    const { systemPrompt, userMessage } = extractPrompt(options.prompt)

    // Build composite prompt: system instructions + user message
    const compositeText = systemPrompt
      ? `<system_instructions>\n${systemPrompt}\n</system_instructions>\n\n${userMessage}`
      : userMessage

    const sessionId = this.session!.sessionId

    // State tracking for stream part generation
    let streamStarted = false
    let textStarted = false
    let reasoningStarted = false
    let outputCharCount = 0
    const textId = "txt-0"
    const reasoningId = "reasoning-0"
    const toolCalls = new Map<string, { name: string; inputStarted: boolean }>()

    // Create a ReadableStream that maps ACP notifications to LanguageModelV3StreamPart
    const { readable, writable } = new TransformStream<LanguageModelV3StreamPart>()
    const writer = writable.getWriter()

    // Helper to write a part to the stream (swallows errors if stream is closed)
    const writePart = async (part: LanguageModelV3StreamPart): Promise<void> => {
      try {
        await writer.write(part)
      } catch {
        // Stream may have been closed by consumer — ignore
      }
    }

    // Emit stream-start exactly once, before the first content part
    const ensureStreamStarted = (): void => {
      if (!streamStarted) {
        streamStarted = true
        void writePart({ type: "stream-start", warnings: [] })
      }
    }

    // Map ACP session updates to AI SDK stream parts
    const handleUpdate = (update: SessionUpdate): void => {
      const updateType = update.sessionUpdate

      if (updateType === "agent_message_chunk") {
        const text = (update.content as { text?: string } | undefined)?.text
        if (text) {
          outputCharCount += text.length
          if (!textStarted) {
            textStarted = true
            ensureStreamStarted()
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
            ensureStreamStarted()
            void writePart({ type: "reasoning-start", id: reasoningId })
          }
          void writePart({ type: "reasoning-delta", id: reasoningId, delta: text })
        }
      } else if (updateType === "tool_call") {
        const status = update.status as string | undefined
        const toolCallId = update.toolCallId as string
        const toolName = extractToolName(update)

        if (status === "in_progress" || status === "pending") {
          // Close reasoning if open
          if (reasoningStarted) {
            reasoningStarted = false
            void writePart({ type: "reasoning-end", id: reasoningId })
          }
          // Close text if open
          if (textStarted) {
            textStarted = false
            void writePart({ type: "text-end", id: textId })
          }

          ensureStreamStarted()
          toolCalls.set(toolCallId, { name: toolName, inputStarted: true })

          // Emit tool-input-start (provider-executed since kiro-cli runs the tool)
          void writePart({
            type: "tool-input-start",
            id: toolCallId,
            toolName,
            providerExecuted: true,
            dynamic: true,
          })

          // If rawInput is available, emit it immediately
          const rawInput = update.rawInput as Record<string, unknown> | undefined
          if (rawInput) {
            const inputStr = JSON.stringify(rawInput)
            void writePart({
              type: "tool-input-delta",
              id: toolCallId,
              delta: inputStr,
            })
            void writePart({
              type: "tool-input-end",
              id: toolCallId,
            })
            void writePart({
              type: "tool-call",
              toolCallId,
              toolName,
              input: inputStr,
              providerExecuted: true,
              dynamic: true,
            })
          }
        }
      } else if (updateType === "tool_call_update") {
        const status = update.status as string | undefined
        const toolCallId = update.toolCallId as string
        const entry = toolCalls.get(toolCallId)

        if (status === "completed" && entry) {
          // If we haven't emitted tool-input-end yet (no rawInput was available earlier)
          // emit the input parts now
          const rawInput = update.rawInput as Record<string, unknown> | undefined
          if (rawInput && entry.inputStarted) {
            const inputStr = JSON.stringify(rawInput)
            void writePart({
              type: "tool-input-delta",
              id: toolCallId,
              delta: inputStr,
            })
            void writePart({
              type: "tool-input-end",
              id: toolCallId,
            })
            void writePart({
              type: "tool-call",
              toolCallId,
              toolName: entry.name,
              input: inputStr,
              providerExecuted: true,
              dynamic: true,
            })
          }

          // Emit tool-result
          const output = extractToolOutput(update)
          void writePart({
            type: "tool-result",
            toolCallId,
            toolName: entry.name,
            result: output || "[no output]",
            dynamic: true,
          })
        }
      }
    }

    // Start the ACP prompt asynchronously
    const promptPromise = this.client.prompt({
      sessionId,
      prompt: [{ type: "text", text: compositeText }],
      onUpdate: handleUpdate,
      signal: options.abortSignal,
    })

    // When the prompt completes, emit finish and close the stream
    promptPromise
      .then(async (result) => {
        // Close any open text/reasoning spans
        if (reasoningStarted) {
          await writePart({ type: "reasoning-end", id: reasoningId })
        }
        if (textStarted) {
          await writePart({ type: "text-end", id: textId })
        }

        // Determine finish reason
        const hasToolCalls = toolCalls.size > 0
        const finishReason = hasToolCalls
          ? { unified: "tool-calls" as const, raw: result.stopReason }
          : mapStopReason(result.stopReason)

        // Emit metadata from ACP
        const metadata = this.client.getMetadata(sessionId)

        // Accumulate credits across turns
        const turnCredits =
          metadata?.meteringUsage?.find((m) => m.unit === "credit")?.value ?? 0
        this.totalCredits += turnCredits

        await writePart({
          type: "finish",
          finishReason,
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
        await writer.close()
      })
      .catch(async (err: unknown) => {
        // Close any open spans before error
        if (reasoningStarted) {
          await writePart({ type: "reasoning-end", id: reasoningId })
        }
        if (textStarted) {
          await writePart({ type: "text-end", id: textId })
        }

        await writePart({ type: "error", error: err })
        try {
          await writer.close()
        } catch {
          // Already closed
        }
      })
      .finally(() => {
        releaseLock!()
      })

    return {
      stream: readable,
      request: { body: compositeText },
      response: { headers: {} },
    }
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
              providerExecuted: value.providerExecuted,
              dynamic: value.dynamic,
            })
          }
          break
        }

        case "tool-result":
          content.push({
            type: "tool-result",
            toolCallId: value.toolCallId,
            toolName: value.toolName,
            result: value.result,
            dynamic: value.dynamic,
          })
          break

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
