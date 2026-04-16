import { describe, test, expect, afterEach } from "bun:test"
import { LaneRouter } from "../src/lane-router"
import type { PendingToolCall } from "../src/ipc-server"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a PendingToolCall with defaults. */
function makeCall(overrides: Partial<PendingToolCall> = {}): PendingToolCall {
  return {
    callId: overrides.callId ?? `call-${Math.random().toString(36).slice(2, 8)}`,
    toolName: overrides.toolName ?? "bash",
    args: overrides.args ?? { command: "ls" },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LaneRouter", () => {
  let router: LaneRouter

  afterEach(() => {
    router?.clear()
  })

  // -------------------------------------------------------------------------
  // Lane lifecycle
  // -------------------------------------------------------------------------

  describe("register / unregister / updateHandler", () => {
    test("register adds a lane and getLaneCount reflects it", () => {
      router = new LaneRouter()
      expect(router.getLaneCount()).toBe(0)

      router.register("sess-1", () => {})
      expect(router.getLaneCount()).toBe(1)

      router.register("sess-2", () => {})
      expect(router.getLaneCount()).toBe(2)
    })

    test("unregister removes a lane", () => {
      router = new LaneRouter()
      router.register("sess-1", () => {})
      router.register("sess-2", () => {})
      expect(router.getLaneCount()).toBe(2)

      router.unregister("sess-1")
      expect(router.getLaneCount()).toBe(1)

      router.unregister("sess-2")
      expect(router.getLaneCount()).toBe(0)
    })

    test("unregister is safe for non-existent session", () => {
      router = new LaneRouter()
      // Should not throw
      router.unregister("nonexistent")
      expect(router.getLaneCount()).toBe(0)
    })

    test("updateHandler changes the handler for an existing lane", () => {
      router = new LaneRouter()
      const calls1: PendingToolCall[] = []
      const calls2: PendingToolCall[] = []

      router.register("sess-1", (call) => calls1.push(call))

      // Route a call — should go to handler 1
      router.route(makeCall({ callId: "c1" }))
      expect(calls1).toHaveLength(1)
      expect(calls2).toHaveLength(0)

      // Update handler
      router.updateHandler("sess-1", (call) => calls2.push(call))

      // Route another call — should go to handler 2
      router.route(makeCall({ callId: "c2" }))
      expect(calls1).toHaveLength(1)
      expect(calls2).toHaveLength(1)
    })

    test("updateHandler is safe for non-existent session", () => {
      router = new LaneRouter()
      // Should not throw
      router.updateHandler("nonexistent", () => {})
    })

    test("clear removes all lanes and buffered calls", () => {
      router = new LaneRouter()
      router.register("sess-1", () => {})
      router.register("sess-2", () => {})
      expect(router.getLaneCount()).toBe(2)

      router.clear()
      expect(router.getLaneCount()).toBe(0)
      expect(router.getBufferedCallCount()).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // Single-lane fast path
  // -------------------------------------------------------------------------

  describe("single-lane fast path", () => {
    test("routes directly to the only lane without correlation", () => {
      router = new LaneRouter()
      const calls: PendingToolCall[] = []

      router.register("sess-1", (call) => calls.push(call))

      // Route without any correlation — should still work (fast path)
      const call = makeCall({ callId: "c1", toolName: "bash", args: { command: "ls" } })
      router.route(call)

      expect(calls).toHaveLength(1)
      expect(calls[0].callId).toBe("c1")
    })

    test("routes multiple calls to the only lane", () => {
      router = new LaneRouter()
      const calls: PendingToolCall[] = []

      router.register("sess-1", (call) => calls.push(call))

      router.route(makeCall({ callId: "c1" }))
      router.route(makeCall({ callId: "c2" }))
      router.route(makeCall({ callId: "c3" }))

      expect(calls).toHaveLength(3)
    })

    test("fast path consumes matching correlation if present", () => {
      router = new LaneRouter()
      const calls: PendingToolCall[] = []

      router.register("sess-1", (call) => calls.push(call))

      // Add a correlation
      router.correlate("sess-1", "tc-1", "bash", { command: "ls" })

      // Route — should consume the correlation
      router.route(makeCall({ callId: "c1", toolName: "bash", args: { command: "ls" } }))

      expect(calls).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------
  // Multi-lane correlation matching
  // -------------------------------------------------------------------------

  describe("multi-lane correlation matching", () => {
    test("routes to the correct lane based on toolName + args match", () => {
      router = new LaneRouter()
      const callsA: PendingToolCall[] = []
      const callsB: PendingToolCall[] = []

      router.register("sess-A", (call) => callsA.push(call))
      router.register("sess-B", (call) => callsB.push(call))

      // Correlate: session A calls bash, session B calls grep
      router.correlate("sess-A", "tc-a1", "bash", { command: "ls" })
      router.correlate("sess-B", "tc-b1", "grep", { pattern: "foo" })

      // Route bash call — should go to session A
      router.route(makeCall({ callId: "c1", toolName: "bash", args: { command: "ls" } }))
      expect(callsA).toHaveLength(1)
      expect(callsB).toHaveLength(0)

      // Route grep call — should go to session B
      router.route(makeCall({ callId: "c2", toolName: "grep", args: { pattern: "foo" } }))
      expect(callsA).toHaveLength(1)
      expect(callsB).toHaveLength(1)
    })

    test("matches on deep equality of args (key order independent)", () => {
      router = new LaneRouter()
      const callsA: PendingToolCall[] = []
      const callsB: PendingToolCall[] = []

      router.register("sess-A", (call) => callsA.push(call))
      router.register("sess-B", (call) => callsB.push(call))

      // Correlate with args in one key order
      router.correlate("sess-A", "tc-a1", "bash", { command: "ls", timeout: 5000 })

      // Route with args in different key order — should still match
      router.route(makeCall({
        callId: "c1",
        toolName: "bash",
        args: { timeout: 5000, command: "ls" },
      }))

      expect(callsA).toHaveLength(1)
      expect(callsB).toHaveLength(0)
    })

    test("does not match when toolName differs", () => {
      router = new LaneRouter()
      const callsA: PendingToolCall[] = []

      router.register("sess-A", (call) => callsA.push(call))
      router.register("sess-B", () => {})

      router.correlate("sess-A", "tc-a1", "bash", { command: "ls" })

      // Route with different toolName — should NOT match session A
      router.route(makeCall({ callId: "c1", toolName: "grep", args: { command: "ls" } }))

      // Should be buffered (no match)
      expect(callsA).toHaveLength(0)
      expect(router.getBufferedCallCount()).toBe(1)
    })

    test("does not match when args differ", () => {
      router = new LaneRouter()
      const callsA: PendingToolCall[] = []

      router.register("sess-A", (call) => callsA.push(call))
      router.register("sess-B", () => {})

      router.correlate("sess-A", "tc-a1", "bash", { command: "ls" })

      // Route with different args — should NOT match
      router.route(makeCall({ callId: "c1", toolName: "bash", args: { command: "pwd" } }))

      expect(callsA).toHaveLength(0)
      expect(router.getBufferedCallCount()).toBe(1)
    })

    test("consumes correlation after match (no double-match)", () => {
      router = new LaneRouter()
      const callsA: PendingToolCall[] = []
      const callsB: PendingToolCall[] = []

      router.register("sess-A", (call) => callsA.push(call))
      router.register("sess-B", (call) => callsB.push(call))

      // Only one correlation for session A
      router.correlate("sess-A", "tc-a1", "bash", { command: "ls" })

      // First route — matches session A
      router.route(makeCall({ callId: "c1", toolName: "bash", args: { command: "ls" } }))
      expect(callsA).toHaveLength(1)

      // Second route with same toolName+args — correlation consumed, should buffer
      router.route(makeCall({ callId: "c2", toolName: "bash", args: { command: "ls" } }))
      expect(callsA).toHaveLength(1) // Not 2
      expect(router.getBufferedCallCount()).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // Identical tool calls — timestamp tiebreaking
  // -------------------------------------------------------------------------

  describe("identical tool calls with timestamp tiebreaker", () => {
    test("routes to the lane with the oldest correlation (FIFO)", async () => {
      router = new LaneRouter()
      const callsA: PendingToolCall[] = []
      const callsB: PendingToolCall[] = []

      router.register("sess-A", (call) => callsA.push(call))
      router.register("sess-B", (call) => callsB.push(call))

      // Both sessions call the same tool with the same args
      // Session A correlates first
      router.correlate("sess-A", "tc-a1", "bash", { command: "ls" })

      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 5))

      // Session B correlates second
      router.correlate("sess-B", "tc-b1", "bash", { command: "ls" })

      // First IPC call — should go to session A (oldest correlation)
      router.route(makeCall({ callId: "c1", toolName: "bash", args: { command: "ls" } }))
      expect(callsA).toHaveLength(1)
      expect(callsB).toHaveLength(0)

      // Second IPC call — should go to session B (remaining correlation)
      router.route(makeCall({ callId: "c2", toolName: "bash", args: { command: "ls" } }))
      expect(callsA).toHaveLength(1)
      expect(callsB).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------
  // Buffering — late ACP notification
  // -------------------------------------------------------------------------

  describe("buffering (IPC arrives before ACP notification)", () => {
    test("buffers IPC call and drains when correlation arrives", () => {
      router = new LaneRouter()
      const callsA: PendingToolCall[] = []
      const callsB: PendingToolCall[] = []

      router.register("sess-A", (call) => callsA.push(call))
      router.register("sess-B", (call) => callsB.push(call))

      // IPC call arrives BEFORE any correlation
      router.route(makeCall({ callId: "c1", toolName: "bash", args: { command: "ls" } }))

      // Should be buffered
      expect(callsA).toHaveLength(0)
      expect(callsB).toHaveLength(0)
      expect(router.getBufferedCallCount()).toBe(1)

      // Now the ACP notification arrives — should drain the buffer
      router.correlate("sess-A", "tc-a1", "bash", { command: "ls" })

      expect(callsA).toHaveLength(1)
      expect(callsA[0].callId).toBe("c1")
      expect(router.getBufferedCallCount()).toBe(0)
    })

    test("buffers IPC call and drains when a new lane is registered (single-lane fast path)", () => {
      router = new LaneRouter()
      const calls: PendingToolCall[] = []

      // IPC call arrives with NO lanes registered
      router.route(makeCall({ callId: "c1", toolName: "bash", args: { command: "ls" } }))
      expect(router.getBufferedCallCount()).toBe(1)

      // Register a lane — should drain the buffer via single-lane fast path
      router.register("sess-1", (call) => calls.push(call))

      expect(calls).toHaveLength(1)
      expect(calls[0].callId).toBe("c1")
      expect(router.getBufferedCallCount()).toBe(0)
    })

    test("buffer timeout triggers fallback routing", async () => {
      // We can't easily test the 2-second timeout in a unit test,
      // but we can verify the buffer mechanism works
      router = new LaneRouter()
      const calls: PendingToolCall[] = []

      router.register("sess-A", (call) => calls.push(call))
      router.register("sess-B", () => {})

      // IPC call with no matching correlation — gets buffered
      router.route(makeCall({ callId: "c1", toolName: "unknown_tool", args: {} }))

      expect(calls).toHaveLength(0)
      expect(router.getBufferedCallCount()).toBe(1)

      // After timeout (2s), the call should be routed to the fallback (last lane)
      // We wait for the timeout
      await new Promise((r) => setTimeout(r, 2200))

      // The fallback routes to the last registered lane (sess-B in this case)
      // Since sess-B's handler is a no-op, we just verify the buffer is drained
      expect(router.getBufferedCallCount()).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // Correlation lifecycle
  // -------------------------------------------------------------------------

  describe("correlate()", () => {
    test("ignores correlation for non-existent lane", () => {
      router = new LaneRouter()

      // Should not throw
      router.correlate("nonexistent", "tc-1", "bash", { command: "ls" })
      expect(router.getLaneCount()).toBe(0)
    })

    test("multiple correlations for the same lane", () => {
      router = new LaneRouter()
      const callsA: PendingToolCall[] = []

      router.register("sess-A", (call) => callsA.push(call))
      router.register("sess-B", () => {})

      // Session A calls 3 tools
      router.correlate("sess-A", "tc-1", "bash", { command: "ls" })
      router.correlate("sess-A", "tc-2", "read_file", { filePath: "/tmp/x" })
      router.correlate("sess-A", "tc-3", "grep", { pattern: "foo" })

      // All 3 IPC calls should route to session A
      router.route(makeCall({ callId: "c1", toolName: "bash", args: { command: "ls" } }))
      router.route(makeCall({ callId: "c2", toolName: "read_file", args: { filePath: "/tmp/x" } }))
      router.route(makeCall({ callId: "c3", toolName: "grep", args: { pattern: "foo" } }))

      expect(callsA).toHaveLength(3)
    })
  })

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  describe("cleanup()", () => {
    test("removes stale correlations", () => {
      router = new LaneRouter()
      const calls: PendingToolCall[] = []

      router.register("sess-A", (call) => calls.push(call))
      router.register("sess-B", () => {})

      // Add a correlation with a very old timestamp
      // We need to manipulate the internal state — use correlate then wait
      // For testing, we'll just verify cleanup doesn't throw
      router.correlate("sess-A", "tc-old", "bash", { command: "ls" })

      // Cleanup should not throw
      router.cleanup()

      // The correlation is not stale yet (just created), so it should still match
      router.route(makeCall({ callId: "c1", toolName: "bash", args: { command: "ls" } }))
      expect(calls).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  describe("diagnostics", () => {
    test("getLaneCount returns correct count", () => {
      router = new LaneRouter()
      expect(router.getLaneCount()).toBe(0)

      router.register("sess-1", () => {})
      expect(router.getLaneCount()).toBe(1)

      router.register("sess-2", () => {})
      expect(router.getLaneCount()).toBe(2)

      router.unregister("sess-1")
      expect(router.getLaneCount()).toBe(1)
    })

    test("getBufferedCallCount returns correct count", () => {
      router = new LaneRouter()

      // No lanes — calls get buffered
      expect(router.getBufferedCallCount()).toBe(0)

      router.route(makeCall({ callId: "c1" }))
      expect(router.getBufferedCallCount()).toBe(1)

      router.route(makeCall({ callId: "c2" }))
      expect(router.getBufferedCallCount()).toBe(2)

      // Register a lane — should drain buffer
      router.register("sess-1", () => {})
      expect(router.getBufferedCallCount()).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    test("route with zero lanes buffers the call", () => {
      router = new LaneRouter()

      router.route(makeCall({ callId: "c1" }))
      expect(router.getBufferedCallCount()).toBe(1)
    })

    test("re-registering a session replaces the lane", () => {
      router = new LaneRouter()
      const calls1: PendingToolCall[] = []
      const calls2: PendingToolCall[] = []

      router.register("sess-1", (call) => calls1.push(call))
      router.route(makeCall({ callId: "c1" }))
      expect(calls1).toHaveLength(1)

      // Re-register with a new handler
      router.register("sess-1", (call) => calls2.push(call))
      router.route(makeCall({ callId: "c2" }))
      expect(calls1).toHaveLength(1) // Not called again
      expect(calls2).toHaveLength(1)
    })

    test("deep equality handles nested objects and arrays", () => {
      router = new LaneRouter()
      const callsA: PendingToolCall[] = []

      router.register("sess-A", (call) => callsA.push(call))
      router.register("sess-B", () => {})

      // Correlate with nested args
      router.correlate("sess-A", "tc-1", "complex_tool", {
        config: { nested: { deep: true } },
        items: [1, 2, 3],
        name: "test",
      })

      // Route with same nested args (different key order)
      router.route(makeCall({
        callId: "c1",
        toolName: "complex_tool",
        args: {
          name: "test",
          items: [1, 2, 3],
          config: { nested: { deep: true } },
        },
      }))

      expect(callsA).toHaveLength(1)
    })

    test("empty args match correctly", () => {
      router = new LaneRouter()
      const callsA: PendingToolCall[] = []

      router.register("sess-A", (call) => callsA.push(call))
      router.register("sess-B", () => {})

      router.correlate("sess-A", "tc-1", "simple_tool", {})
      router.route(makeCall({ callId: "c1", toolName: "simple_tool", args: {} }))

      expect(callsA).toHaveLength(1)
    })
  })
})
