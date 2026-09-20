import type { LanguageModelV3Message, LanguageModelV3Prompt } from "@ai-sdk/provider"
import type { ContentBlock } from "./acp-client"

// ---------------------------------------------------------------------------
// V3 prompt -> ACP ContentBlock[] serialization
//
// OpenCode replays its full history on every call; kiro's ACP session is
// stateful. The model layer decides WHICH messages to send (delta or full
// replay); this module only renders a given slice losslessly for text.
// ---------------------------------------------------------------------------

export const REPLAY_TOOL_RESULT_MAX_CHARS = 8000

export interface SerializedPrompt {
  blocks: ContentBlock[]
}

export interface SerializeOptions {
  /** Emit images in the LAST user message as image blocks. Older images are placeholders. */
  imagesAsBlocks: boolean
}

type UserMessage = Extract<LanguageModelV3Message, { role: "user" }>
type AssistantMessage = Extract<LanguageModelV3Message, { role: "assistant" }>
type ToolMessage = Extract<LanguageModelV3Message, { role: "tool" }>
type ToolResultPart = Extract<ToolMessage["content"][number], { type: "tool-result" }>

/** All `system` messages joined with a blank line. `undefined` when there are none. */
export function systemPromptText(prompt: LanguageModelV3Prompt): string | undefined {
  const parts: string[] = []
  for (const message of prompt) {
    if (message.role === "system") parts.push(message.content)
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined
}

export function nonSystemMessages(prompt: LanguageModelV3Prompt): LanguageModelV3Message[] {
  return prompt.filter((m) => m.role !== "system")
}

export function toBase64Data(data: Uint8Array | string | URL): string {
  if (data instanceof Uint8Array) {
    return Buffer.from(data).toString("base64")
  }
  if (data instanceof URL) {
    if (data.protocol === "data:") {
      const href = data.href
      const marker = ";base64,"
      const at = href.indexOf(marker)
      if (at !== -1) return href.slice(at + marker.length)
      const comma = href.indexOf(",")
      if (comma !== -1) return href.slice(comma + 1)
    }
    // http(s) URL: the agent has to fetch it. Best effort.
    return data.href
  }
  return data
}

/** AI SDK may send `image/*`; kiro needs a concrete MIME type. */
export function normalizeMediaType(mediaType: string): string {
  if (mediaType === "image/*") return "image/jpeg"
  return mediaType
}

export function isImageMediaType(mediaType: string): boolean {
  return mediaType.startsWith("image/") || mediaType === "image/*"
}

function truncate(value: string): string {
  if (value.length <= REPLAY_TOOL_RESULT_MAX_CHARS) return value
  const cut = value.length - REPLAY_TOOL_RESULT_MAX_CHARS
  return `${value.slice(0, REPLAY_TOOL_RESULT_MAX_CHARS)}\n…[truncated ${cut} chars]`
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Incremental builder: adjacent text sections merge into one text block,
 * image blocks split the text. Never produces two adjacent text blocks.
 */
class BlockBuilder {
  private blocks: ContentBlock[] = []
  private pendingText: string[] = []

  text(section: string): void {
    if (section.length === 0) return
    this.pendingText.push(section)
  }

  image(data: string, mimeType: string): void {
    this.flush()
    this.blocks.push({ type: "image", data, mimeType })
  }

  private flush(): void {
    if (this.pendingText.length === 0) return
    this.blocks.push({ type: "text", text: this.pendingText.join("\n\n") })
    this.pendingText = []
  }

  finish(): ContentBlock[] {
    this.flush()
    return this.blocks
  }
}

function renderUser(message: UserMessage, out: BlockBuilder, label: boolean, imagesAsBlocks: boolean): void {
  let buffer: string[] = []
  const flushText = () => {
    const body = buffer.join("\n")
    buffer = []
    if (body.length === 0 && !label) return
    if (!label) out.text(body)
    else out.text(body.length === 0 ? "[User]" : `[User]\n${body}`)
    // Only the first text run of a message carries the label.
    label = false
  }

  for (const part of message.content) {
    if (part.type === "text") {
      buffer.push(part.text)
      continue
    }
    if (part.type === "file") {
      if (isImageMediaType(part.mediaType)) {
        const mime = normalizeMediaType(part.mediaType)
        if (imagesAsBlocks) {
          flushText()
          out.image(toBase64Data(part.data), mime)
        } else {
          buffer.push(`[Image: ${mime}]`)
        }
        continue
      }
      buffer.push(part.filename ? `[File: ${part.mediaType} ${part.filename}]` : `[File: ${part.mediaType}]`)
    }
  }
  if (buffer.length > 0 || label) flushText()
}

function renderAssistant(message: AssistantMessage, out: BlockBuilder): void {
  const lines: string[] = []
  for (const part of message.content) {
    if (part.type === "text") {
      lines.push(`[Assistant]\n${part.text}`)
      continue
    }
    if (part.type === "tool-call") {
      const input = typeof part.input === "string" ? part.input : stringifyJson(part.input)
      lines.push(`[Assistant tool call] ${part.toolName}(${input})`)
      continue
    }
    if (part.type === "tool-result") {
      lines.push(renderToolResult(part))
    }
    // reasoning and file parts are model-internal / not replayable; omitted.
  }
  if (lines.length > 0) out.text(lines.join("\n"))
}

function renderToolResult(part: ToolResultPart): string {
  const output = part.output
  switch (output.type) {
    case "text":
      return `[Tool result: ${part.toolName}]\n${truncate(output.value)}`
    case "json":
      return `[Tool result: ${part.toolName}]\n${truncate(stringifyJson(output.value))}`
    case "error-text":
      return `[Tool error: ${part.toolName}]\n${truncate(output.value)}`
    case "error-json":
      return `[Tool error: ${part.toolName}]\n${truncate(stringifyJson(output.value))}`
    case "execution-denied":
      return `[Tool error: ${part.toolName}]\nExecution denied${output.reason ? `: ${output.reason}` : ""}`
    case "content": {
      const items = output.value.map((item) => {
        if (item.type === "text") return item.text
        if (item.type === "file-data") {
          return isImageMediaType(item.mediaType)
            ? `[Image: ${normalizeMediaType(item.mediaType)}]`
            : `[File: ${item.mediaType}]`
        }
        if (item.type === "file-url") return `[File: ${item.url}]`
        return `[File]`
      })
      return `[Tool result: ${part.toolName}]\n${truncate(items.join("\n"))}`
    }
    default:
      return `[Tool result: ${part.toolName}]\n${truncate(stringifyJson(output))}`
  }
}

function renderTool(message: ToolMessage, out: BlockBuilder): void {
  const lines: string[] = []
  for (const part of message.content) {
    if (part.type === "tool-result") lines.push(renderToolResult(part))
  }
  if (lines.length > 0) out.text(lines.join("\n"))
}

/**
 * Render an ordered slice of non-system messages as ACP content blocks.
 *
 * A single user message is rendered verbatim (no `[User]` label). Any other
 * shape labels every section so kiro can tell the speakers apart.
 */
export function serializeMessages(
  messages: LanguageModelV3Message[],
  opts: SerializeOptions,
): SerializedPrompt {
  const out = new BlockBuilder()
  const single = messages.length === 1 && messages[0].role === "user"
  const lastUserIndex = findLastUserIndex(messages)

  messages.forEach((message, index) => {
    if (message.role === "system") return
    if (message.role === "user") {
      renderUser(message, out, !single, opts.imagesAsBlocks && index === lastUserIndex)
      return
    }
    if (message.role === "assistant") {
      renderAssistant(message, out)
      return
    }
    renderTool(message, out)
  })

  return { blocks: out.finish() }
}

function findLastUserIndex(messages: LanguageModelV3Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i
  }
  return -1
}
