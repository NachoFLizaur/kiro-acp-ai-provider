import { describe, test, expect } from "bun:test"
import { reasoningEffortsFor } from "../src/index"

// ---------------------------------------------------------------------------
// reasoningEffortsFor: per-model native kiro effort vocabularies, relayed
// verbatim (no remapping).
// ---------------------------------------------------------------------------

describe("reasoningEffortsFor", () => {
  test("returns matrix list for effort model", () => {
    // opus-4.8 / opus-4.7 expose the extra "xhigh" level.
    expect(reasoningEffortsFor("claude-opus-4.8")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
    expect(reasoningEffortsFor("claude-opus-4.7")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])

    // opus-4.6 / sonnet-4.6 top out at "max" (no "xhigh").
    expect(reasoningEffortsFor("claude-opus-4.6")).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ])
    expect(reasoningEffortsFor("claude-sonnet-4.6")).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ])
  })

  test("returns empty for non-effort model", () => {
    // Models with no effort control return an empty list (the common case).
    expect(reasoningEffortsFor("claude-opus-4.5")).toEqual([])
    expect(reasoningEffortsFor("glm-5")).toEqual([])
  })

  test("returns empty for unknown model", () => {
    // Unknown ids degrade safely to an empty list rather than throwing.
    expect(reasoningEffortsFor("does-not-exist")).toEqual([])
  })

  test("preserves native level names", () => {
    // No remapping: the returned strings are the literal kiro-cli level names.
    const levels = reasoningEffortsFor("claude-opus-4.8")
    expect(levels).toEqual(["low", "medium", "high", "xhigh", "max"])

    // Returns a fresh array so callers cannot corrupt the internal vocabulary.
    levels.pop()
    expect(reasoningEffortsFor("claude-opus-4.8")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
  })
})
