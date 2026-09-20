import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import { createHash } from "node:crypto"
import type { ContentBlock } from "./acp-client"
import { diverged } from "./session-affinity"
import { nonSystemMessages, serializeMessages, systemPromptText } from "./prompt-serializer"

// ---------------------------------------------------------------------------
// History sync: decide what a stateful kiro session still needs to see.
//
// OpenCode is the source of truth and re-sends its full history on every
// call. Per affinity key the model remembers the hashes of the non-system
// messages already delivered to the live kiro session (`prev`). A call that
// extends that prefix sends only the tail (CONTINUE). Anything else
// (compaction, revert, fork, restart with unknown state) starts a new kiro
// session and replays the whole prompt (REPLAY).
// ---------------------------------------------------------------------------

export type SyncMode = "continue" | "replay"

export interface SyncPlan {
  mode: SyncMode
  /** Index into the non-system messages where the delivered slice starts. 0 for replay. */
  start: number
}

export const REPLAY_PREAMBLE = "The following is the conversation so far. Continue from the last message."

export function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex")
}

/**
 * @param prev    hashes delivered to the current kiro session, `undefined` when unknown
 * @param hashes  hashes of the current prompt's non-system messages
 * @param roles   roles of the same non-system messages, in order
 * @param forceReset  host asked for a reset (`x-session-reset`)
 */
export function planSync(
  prev: string[] | undefined,
  hashes: string[],
  roles: string[],
  forceReset: boolean,
): SyncPlan {
  if (forceReset) return { mode: "replay", start: 0 }

  const hasHistory = roles.some((r) => r !== "user")
  if (!prev || prev.length === 0) {
    return hasHistory ? { mode: "replay", start: 0 } : { mode: "continue", start: 0 }
  }

  if (diverged(prev, hashes)) return { mode: "replay", start: 0 }

  if (hashes.length > prev.length) {
    // Assistant/tool messages right after the delivered prefix came out of
    // kiro's own turn; it already has them. Deliver from the next user message.
    let start = prev.length
    while (start < roles.length && roles[start] !== "user") start++
    if (start >= roles.length) return { mode: "replay", start: 0 }
    return { mode: "continue", start }
  }

  // Identical prompt re-sent (host retry). Re-deliver the trailing user run
  // rather than throwing the session away.
  const lastNonUser = roles.findLastIndex((r) => r !== "user")
  const start = lastNonUser + 1
  if (start >= roles.length) return { mode: "replay", start: 0 }
  return { mode: "continue", start }
}

export interface SystemState {
  /** sha1 of the system prompt text last delivered to this kiro session. */
  hash: string | undefined
  /** Whether a system prompt has been delivered at all on this kiro session. */
  delivered: boolean
}

/**
 * Shared across every model a provider creates: OpenCode may switch models
 * mid-session and the kiro session (keyed by affinity) is the same one.
 */
export interface HistorySyncState {
  delivered: Map<string, string[]>
  system: Map<string, SystemState>
  /** affinity → kiro sessionId the delivered prefix belongs to. */
  sessions: Map<string, string>
}

export function createHistorySyncState(): HistorySyncState {
  return { delivered: new Map(), system: new Map(), sessions: new Map() }
}

/** Forget everything delivered to `sessionId`; the next turn on those affinities replays. */
export function invalidateSession(state: HistorySyncState, sessionId: string): string[] {
  const affinities = [...state.sessions.entries()]
    .filter(([, sid]) => sid === sessionId)
    .map(([affinity]) => affinity)
  for (const affinity of affinities) {
    state.delivered.delete(affinity)
    state.system.delete(affinity)
    state.sessions.delete(affinity)
  }
  return affinities
}

export interface BuiltPrompt {
  blocks: ContentBlock[]
  systemHash: string | undefined
}

/** Merge `text` into the first block when it is text; otherwise prepend a new text block. */
function prependText(blocks: ContentBlock[], text: string): ContentBlock[] {
  if (blocks.length > 0 && blocks[0].type === "text") {
    return [{ type: "text", text: `${text}\n\n${blocks[0].text ?? ""}` }, ...blocks.slice(1)]
  }
  return [{ type: "text", text }, ...blocks]
}

/**
 * Render the ACP prompt for a sync plan.
 *
 * CONTINUE: the delta slice, preceded by `<system_instructions>` on the first
 * delivery to this kiro session or `<system-update>` when the text changed.
 * REPLAY: `<system_instructions>` + preamble + the full non-system history.
 */
export function buildPromptBlocks(
  prompt: LanguageModelV3Prompt,
  plan: SyncPlan,
  system: SystemState,
): BuiltPrompt {
  const sys = systemPromptText(prompt)
  const systemHash = sys === undefined ? undefined : sha1(sys)
  const messages = nonSystemMessages(prompt)

  if (plan.mode === "replay") {
    let { blocks } = serializeMessages(messages, { imagesAsBlocks: true })
    if (messages.length > 1) blocks = prependText(blocks, REPLAY_PREAMBLE)
    if (sys !== undefined) blocks = prependText(blocks, `<system_instructions>\n${sys}\n</system_instructions>`)
    return { blocks, systemHash }
  }

  let { blocks } = serializeMessages(messages.slice(plan.start), { imagesAsBlocks: true })
  if (sys !== undefined) {
    if (!system.delivered) {
      blocks = prependText(blocks, `<system_instructions>\n${sys}\n</system_instructions>`)
    } else if (system.hash !== systemHash) {
      blocks = prependText(blocks, `<system-update>\n${sys}\n</system-update>`)
    }
  }
  return { blocks, systemHash }
}
