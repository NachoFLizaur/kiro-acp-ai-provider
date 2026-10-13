import { describe, test, expect } from "bun:test"
import { InstructionDeliveryLedger, INSTRUCTION_DELIVERY_HIGH_WATER_PERCENT } from "../src/delivery-ledger"

describe("InstructionDeliveryLedger", () => {
  test("AC2: proof is per session, not per caller", () => {
    const ledger = new InstructionDeliveryLedger()
    expect(ledger.needsInstructions("one", "A")).toBe(true)
    expect(ledger.acknowledge(ledger.open("one", "A"), "end_turn")).toBe(true)
    expect(ledger.needsInstructions("one", "A")).toBe(false)
    expect(ledger.needsInstructions("two", "A")).toBe(true)
    ledger.acknowledge(ledger.open("two", "A"), "end_turn")
    expect(ledger.needsInstructions("two", "A")).toBe(false)
  })

  test("AC3: text comparison is exact, including whitespace", () => {
    const ledger = new InstructionDeliveryLedger()
    ledger.acknowledge(ledger.open("one", "A\n\nB"), "end_turn")
    expect(ledger.needsInstructions("one", "A\n\nB")).toBe(false)
    expect(ledger.needsInstructions("one", "A\nB")).toBe(true)
    expect(ledger.needsInstructions("one", "A\n\nB ")).toBe(true)
  })

  test("AC4: in-flight sends cannot suppress another send", () => {
    const ledger = new InstructionDeliveryLedger()
    const first = ledger.open("one", "A")
    expect(ledger.needsInstructions("one", "A")).toBe(true)
    const second = ledger.open("one", "A")
    expect(ledger.acknowledge(first, "end_turn")).toBe(false)
    expect(ledger.needsInstructions("one", "A")).toBe(true)
    expect(ledger.acknowledge(second, "end_turn")).toBe(true)
    expect(ledger.needsInstructions("one", "A")).toBe(false)
  })

  test.each(["cancelled", "rejected", "aborted"])("AC4: acknowledged A then %s B never restores A", (outcome) => {
    const ledger = new InstructionDeliveryLedger()
    ledger.acknowledge(ledger.open("one", "A"), "end_turn")
    const replacement = ledger.open("one", "B")
    expect(ledger.needsInstructions("one", "A")).toBe(true)
    if (outcome === "cancelled") expect(ledger.acknowledge(replacement, "cancelled")).toBe(false)
    else ledger.fail(replacement)
    expect(ledger.needsInstructions("one", "A")).toBe(true)
    expect(ledger.needsInstructions("one", "B")).toBe(true)
    // A late success must not acknowledge an already failed delivery.
    expect(ledger.acknowledge(replacement, "end_turn")).toBe(false)
    ledger.acknowledge(ledger.open("one", "A"), "end_turn")
    expect(ledger.needsInstructions("one", "A")).toBe(false)
  })

  test.each(["success", "cancelled", "rejected"])("AC4: late A %s cannot overwrite acknowledged B or force resend", (outcome) => {
    const ledger = new InstructionDeliveryLedger()
    ledger.recordUsage("one", 20)
    const a = ledger.open("one", "A")
    const b = ledger.open("one", "B")
    expect(b.sequence).toBeGreaterThan(a.sequence)
    expect(ledger.acknowledge(b, "end_turn")).toBe(true)
    if (outcome === "rejected") ledger.fail(a)
    else expect(ledger.acknowledge(a, outcome === "cancelled" ? "cancelled" : "end_turn")).toBe(false)
    expect(ledger.needsInstructions("one", "B")).toBe(false)
    expect(ledger.needsInstructions("one", "A")).toBe(true)
  })

  test("AC4: failed newest send cannot revive an older overlapping success", () => {
    const ledger = new InstructionDeliveryLedger()
    const a = ledger.open("one", "A")
    ledger.fail(ledger.open("one", "B"))
    expect(ledger.acknowledge(a, "end_turn")).toBe(false)
    expect(ledger.needsInstructions("one", "A")).toBe(true)
    expect(ledger.needsInstructions("one", "B")).toBe(true)
  })

  test.each(["session", "all"])("AC3/AC4: %s invalidation voids proof and in-flight tokens", (scope) => {
    const ledger = new InstructionDeliveryLedger()
    for (const id of ["one", "two"]) ledger.acknowledge(ledger.open(id, "A"), "end_turn")
    const pending = ledger.open("one", "B")
    if (scope === "session") ledger.invalidate("one")
    else ledger.invalidateAll()
    expect(ledger.acknowledge(pending, "end_turn")).toBe(false)
    expect(ledger.needsInstructions("one", "A")).toBe(true)
    expect(ledger.needsInstructions("one", "B")).toBe(true)
    expect(ledger.needsInstructions("two", "A")).toBe(scope === "all")
    const current = ledger.open("one", "B")
    expect(current.invalidation > pending.invalidation || current.epoch > pending.epoch).toBe(true)
    expect(ledger.acknowledge(current, "end_turn")).toBe(true)
    // Another attempt to settle the old token cannot undo current proof.
    ledger.fail(pending)
    expect(ledger.needsInstructions("one", "B")).toBe(false)
  })

  test("AC13: live per-turn usage preserves delivery on turns 2, 3 and later; high-water still re-sends", () => {
    const ledger = new InstructionDeliveryLedger()
    const first = ledger.open("one", "A")
    // kiro-cli 2.28.0 session S from DISCOVERY's 5a live findings, in percentage points.
    ledger.recordUsage("one", 0.3299) // turn 1 end
    expect(ledger.acknowledge(first, "end_turn")).toBe(true)
    for (const [start, end] of [[0.1782, 0.3445], [0.1783, 0.3863]]) {
      expect(ledger.needsInstructions("one", "A")).toBe(false)
      ledger.recordUsage("one", start) // turns 2 and 3 start below the previous end
      expect(ledger.needsInstructions("one", "A")).toBe(false)
      ledger.recordUsage("one", end)
      expect(ledger.needsInstructions("one", "A")).toBe(false)
    }
    ledger.recordUsage("one", 0.2192) // turn 4 start
    expect(ledger.needsInstructions("one", "A")).toBe(false)

    ledger.recordUsage("one", INSTRUCTION_DELIVERY_HIGH_WATER_PERCENT)
    for (let i = 0; i < 2; i++) {
      expect(ledger.needsInstructions("one", "A")).toBe(true)
      expect(ledger.acknowledge(ledger.open("one", "A"), "end_turn")).toBe(true)
    }
    // Only the latest reading is retained, not a peak or an invalidation.
    ledger.recordUsage("one", INSTRUCTION_DELIVERY_HIGH_WATER_PERCENT - 1)
    expect(ledger.needsInstructions("one", "A")).toBe(false)
  })

  test("AC13/AC4: live start-of-turn lower usage does not void an in-flight token", () => {
    const ledger = new InstructionDeliveryLedger()
    ledger.recordUsage("one", 0.3299)
    for (const [start, end] of [[0.1782, 0.3445], [0.1783, 0.3863]]) {
      const token = ledger.open("one", "A")
      ledger.recordUsage("one", start)
      expect(ledger.acknowledge(token, "end_turn")).toBe(true)
      expect(ledger.needsInstructions("one", "A")).toBe(false)
      ledger.recordUsage("one", end)
      expect(ledger.needsInstructions("one", "A")).toBe(false)
    }
  })

  test("AC3: first, equal and increasing usage are not invalidation evidence", () => {
    const ledger = new InstructionDeliveryLedger()
    ledger.acknowledge(ledger.open("one", "A"), "end_turn")
    for (const pct of [20, 20, 21]) {
      ledger.recordUsage("one", pct)
      expect(ledger.needsInstructions("one", "A")).toBe(false)
    }
  })

  test("AC3: missing and non-finite usage preserve the previous reading", () => {
    const ledger = new InstructionDeliveryLedger()
    ledger.recordUsage("one", 70)
    ledger.acknowledge(ledger.open("one", "A"), "end_turn")
    for (const pct of [undefined, NaN, Infinity, -Infinity]) {
      ledger.recordUsage("one", pct)
      expect(ledger.needsInstructions("one", "A")).toBe(true)
    }
    ledger.recordUsage("one", 40)
    expect(ledger.needsInstructions("one", "A")).toBe(false)
  })

  test.each([69.999, 70, 70.001, 100])("AC3: usage %s obeys the inclusive 70 percent threshold on every prompt", (pct) => {
    const ledger = new InstructionDeliveryLedger()
    expect(INSTRUCTION_DELIVERY_HIGH_WATER_PERCENT).toBe(70)
    ledger.recordUsage("one", pct)
    for (let i = 0; i < 2; i++) {
      ledger.acknowledge(ledger.open("one", "A"), "end_turn")
      expect(ledger.needsInstructions("one", "A")).toBe(pct >= 70)
    }
  })

  test("AC3: a caller can override highWater without changing proof", () => {
    const ledger = new InstructionDeliveryLedger()
    ledger.recordUsage("one", 65)
    ledger.acknowledge(ledger.open("one", "A"), "end_turn")
    expect(ledger.needsInstructions("one", "A", { highWater: 60 })).toBe(true)
    expect(ledger.needsInstructions("one", "A")).toBe(false)
  })

  test("AC3/AC4: a new generation clears proof and usage and ignores late old tokens", () => {
    const ledger = new InstructionDeliveryLedger()
    ledger.acknowledge(ledger.open("one", "A"), "end_turn")
    const old = ledger.open("one", "B")
    ledger.recordUsage("one", 90)
    ledger.advanceGeneration()
    expect(ledger.needsInstructions("one", "A")).toBe(true)
    const current = ledger.open("one", "B")
    expect(current.generation).toBeGreaterThan(old.generation)
    expect(ledger.acknowledge(old, "end_turn")).toBe(false)
    expect(ledger.acknowledge(current, "end_turn")).toBe(true)
    ledger.fail(old)
    expect(ledger.needsInstructions("one", "B")).toBe(false)
  })

  test("AC2/AC4: another ledger's token with identical fields cannot acknowledge", () => {
    const first = new InstructionDeliveryLedger()
    const second = new InstructionDeliveryLedger()
    const a = first.open("one", "A")
    const b = second.open("one", "A")
    expect(a).toEqual(b)
    expect(second.acknowledge(a, "end_turn")).toBe(false)
    expect(second.needsInstructions("one", "A")).toBe(true)
    expect(second.acknowledge(b, "end_turn")).toBe(true)
    expect(second.needsInstructions("one", "A")).toBe(false)
    expect(Object.isFrozen(b)).toBe(true)
  })

  test("AC5: empty-text query does not disturb proof or a pending delivery", () => {
    const ledger = new InstructionDeliveryLedger()
    expect(ledger.needsInstructions("one", "")).toBe(false)
    const token = ledger.open("one", "A")
    expect(ledger.needsInstructions("one", "")).toBe(false)
    expect(ledger.acknowledge(token, "end_turn")).toBe(true)
    expect(ledger.needsInstructions("one", "")).toBe(false)
    expect(ledger.needsInstructions("one", "A")).toBe(false)
  })
})
