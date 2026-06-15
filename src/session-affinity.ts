import { createHash } from "node:crypto"
import type { LanguageModelV3CallOptions, LanguageModelV3Prompt } from "@ai-sdk/provider"

// ---------------------------------------------------------------------------
// Session-affinity intercept
//
// Keyed on the `x-session-affinity` request header a host sets on every
// request: detects conversation divergence (revert/fork/truncation) per
// affinity key and signals it downstream via `x-session-reset: "true"`, plus
// isolates toolless ("ephemeral") calls on a `<affinity>:ephemeral` key.
// ---------------------------------------------------------------------------

/**
 * Stable fast hash used to fingerprint prompt messages.
 *
 * Stable SHA-1 hex fingerprint so divergence detection behaves bit-for-bit
 * across runs. Deterministic and dependency-free (node:crypto builtin).
 */
function fastHash(input: string): string {
  return createHash("sha1").update(input).digest("hex")
}

/** Minimal structural view of a prompt content part for hash normalization. */
interface HashablePart {
  type: string
  text?: string
  mediaType?: string
  filename?: string
  toolCallId?: string
  toolName?: string
}

/**
 * Hash NON-SYSTEM messages only — system prompts have dynamic content that
 * changes between calls, causing false resets. Binary/image payloads are
 * stripped before hashing so serialization differences (Uint8Array vs base64
 * of the same image) cannot trigger false resets.
 *
 * Normalization table:
 * - `text`        → `{ t: "text", v: text }`
 * - `file`        → `{ t: "file", m: mediaType, f: filename }` (data stripped)
 * - `image`       → `{ t: "image" }` (payload stripped)
 * - `tool-call`   → `{ t: "tc", id: toolCallId, n: toolName }`
 * - `tool-result` → `{ t: "tr", id: toolCallId }`
 * - anything else → `{ t: type }`
 * - non-array content passes through as-is
 *
 * @returns One stable hash per non-system message, in prompt order.
 */
export function hashPromptMessages(prompt: LanguageModelV3Prompt): string[] {
  return prompt
    .filter((m) => m.role !== "system")
    .map((m) => {
      const content = Array.isArray(m.content)
        ? (m.content as unknown[]).map((part) => {
            const p = part as HashablePart
            if (p.type === "text") return { t: "text", v: p.text }
            if (p.type === "file") return { t: "file", m: p.mediaType, f: p.filename }
            if (p.type === "image") return { t: "image" }
            if (p.type === "tool-call") return { t: "tc", id: p.toolCallId, n: p.toolName }
            if (p.type === "tool-result") return { t: "tr", id: p.toolCallId }
            return { t: p.type }
          })
        : m.content
      return fastHash(JSON.stringify({ r: m.role, c: content }))
    })
}

/**
 * True when `msgs` is NOT a continuation of `prev`: either the new message
 * list is shorter than the tracked one (truncation) or any element of the
 * tracked prefix differs (history rewrite).
 */
export function diverged(prev: string[], msgs: string[]): boolean {
  if (msgs.length < prev.length) return true
  for (let i = 0; i < prev.length; i++) {
    if (prev[i] !== msgs[i]) return true
  }
  return false
}

/**
 * Session-affinity/reset intercept, applied as a pre-step to
 * `doStream`/`doGenerate`.
 *
 * Behavior:
 * - No `x-session-affinity` header → returns `options` UNCHANGED (same
 *   reference); zero impact on AI SDK consumers that don't set it.
 * - Toolless calls are "ephemeral": tracked under `<affinity>:ephemeral` and
 *   the `x-session-affinity` header is rewritten to that key so downstream
 *   bookkeeping isolates them from the tooled conversation.
 * - A reset (`x-session-reset: "true"`) is signaled when (a) the tracked
 *   key's new messages diverge from the previous prefix, or (b) the FIRST
 *   tracked call already contains assistant/tool history (e.g. the host
 *   restarted mid-conversation, or a fork/revert landed on a fresh key).
 * - Pure continuation on a non-ephemeral key returns the ORIGINAL options
 *   object untouched — preserves reference equality.
 *
 * @param prompts Provider-level shared affinity state: tracked message hashes
 *                per affinity key. Mutated on every intercepted call.
 */
export function interceptSessionAffinity(
  options: LanguageModelV3CallOptions,
  prompts: Map<string, string[]>,
): LanguageModelV3CallOptions {
  const affinity = options.headers?.["x-session-affinity"]
  if (typeof affinity !== "string") return options

  // Legacy `mode.tools` fallback for the pre-v3 call shape.
  const tools = options.tools ?? (options as { mode?: { tools?: unknown[] } }).mode?.tools ?? []
  const ephemeral = tools.length === 0
  const key = ephemeral ? `${affinity}:ephemeral` : affinity

  const msgs = hashPromptMessages(options.prompt)
  const prev = prompts.get(key)
  const hasHistory = options.prompt.some((m) => m.role === "assistant" || m.role === "tool")
  const reset = prev ? diverged(prev, msgs) : hasHistory
  prompts.set(key, msgs)

  if (!reset && !ephemeral) return options

  return {
    ...options,
    headers: {
      ...options.headers,
      ...(ephemeral ? { "x-session-affinity": key } : {}),
      ...(reset ? { "x-session-reset": "true" } : {}),
    },
  }
}
