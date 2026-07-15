// ---------------------------------------------------------------------------
// Per-model reasoning effort vocabularies
// ---------------------------------------------------------------------------

/** Native kiro effort level names, relayed to kiro-cli verbatim (no remapping). */
export type KiroEffortLevel = "low" | "medium" | "high" | "xhigh" | "max"

/**
 * Per-model effort vocabularies, ordered low to high. Only effort-capable
 * models appear; `ensureEffort` uses this as the allow-list. One-directional:
 * kiro removing a level degrades gracefully, but adding a level or model needs
 * an SDK update.
 */
const PER_MODEL_EFFORTS: Record<string, readonly KiroEffortLevel[]> = {
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4.8": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4.7": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4.6": ["low", "medium", "high", "max"],
  "claude-sonnet-4.6": ["low", "medium", "high", "max"],
}

/** Effort levels for a model, low to high. Fresh array; empty when none. */
export function reasoningEffortsFor(modelId: string): KiroEffortLevel[] {
  return [...(PER_MODEL_EFFORTS[modelId] ?? [])]
}

/** Per-model native default effort, matching kiro-cli's own defaults. */
const PER_MODEL_DEFAULT_EFFORTS: Record<string, KiroEffortLevel> = {
  "claude-opus-4.8": "high",
  "claude-opus-4.7": "xhigh",
  "claude-opus-4.6": "high",
  "claude-sonnet-4.6": "high",
}

/**
 * Native default effort for a model, or undefined when it has no effort
 * control. The final fallback for an unset request, so the session resets to
 * default rather than staying stuck at the last explicit level.
 */
export function defaultEffortFor(modelId: string): KiroEffortLevel | undefined {
  return PER_MODEL_DEFAULT_EFFORTS[modelId]
}
