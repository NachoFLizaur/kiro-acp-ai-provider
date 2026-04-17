// ---------------------------------------------------------------------------
// Lane Router — Per-session tool call routing for concurrent doStream() calls
// ---------------------------------------------------------------------------
//
// Routes IPC tool calls to the correct doStream() stream by correlating them
// with ACP session/update notifications via toolName + args deep equality.
//
// Single-lane fast path: when only one lane is registered (common case),
// correlation matching is skipped entirely.
// ---------------------------------------------------------------------------

import type { PendingToolCall } from "./ipc-server"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingCorrelation {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  timestamp: number
}

interface Lane {
  sessionId: string
  handler: (call: PendingToolCall) => void
  pendingCorrelations: Map<string, PendingCorrelation>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CORRELATION_BUFFER_TIMEOUT_MS = 2_000
const CORRELATION_MAX_AGE_MS = 30_000

// ---------------------------------------------------------------------------
// Deep equality helpers
// ---------------------------------------------------------------------------

function sortKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj
  if (Array.isArray(obj)) return obj.map(sortKeys)
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((obj as Record<string, unknown>)[key])
  }
  return sorted
}

/** Deep equality via JSON serialization (sufficient for plain JSON tool args). */
function deepEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
}

// ---------------------------------------------------------------------------
// LaneRouter
// ---------------------------------------------------------------------------

export class LaneRouter {
  private readonly lanes = new Map<string, Lane>()

  private readonly bufferedCalls: Array<{
    call: PendingToolCall
    timestamp: number
    timer: ReturnType<typeof setTimeout>
  }> = []

  // -------------------------------------------------------------------------
  // Lane lifecycle
  // -------------------------------------------------------------------------

  register(sessionId: string, handler: (call: PendingToolCall) => void): void {
    this.lanes.set(sessionId, {
      sessionId,
      handler,
      pendingCorrelations: new Map(),
    })

    this.drainBufferedCalls()
  }

  unregister(sessionId: string): void {
    this.lanes.delete(sessionId)
  }

  /** Update the handler for an existing lane (used during resumption). */
  updateHandler(sessionId: string, handler: (call: PendingToolCall) => void): void {
    const lane = this.lanes.get(sessionId)
    if (lane) {
      lane.handler = handler
    }
  }

  // -------------------------------------------------------------------------
  // Correlation
  // -------------------------------------------------------------------------

  /**
   * Record a pending correlation from an ACP tool_call notification.
   * Creates a "reservation" that the next matching IPC call should be
   * routed to this session's lane.
   */
  correlate(
    sessionId: string,
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): void {
    const lane = this.lanes.get(sessionId)
    if (!lane) return

    lane.pendingCorrelations.set(toolCallId, {
      toolCallId,
      toolName,
      args,
      timestamp: Date.now(),
    })

    this.drainBufferedCalls()
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  route(call: PendingToolCall): void {
    // Fast path: single lane → skip correlation
    if (this.lanes.size === 1) {
      const [, lane] = [...this.lanes][0]
      this.consumeCorrelation(lane, call)
      lane.handler(call)
      return
    }

    if (this.lanes.size === 0) {
      this.bufferCall(call)
      return
    }

    const match = this.findMatchingLane(call)
    if (match) {
      this.consumeCorrelation(match, call)
      match.handler(call)
      return
    }

    this.bufferCall(call)
  }

  // -------------------------------------------------------------------------
  // Internal: matching
  // -------------------------------------------------------------------------

  /**
   * Find a lane with a matching correlation (toolName + args deep equality).
   * Uses oldest correlation timestamp as tiebreaker (FIFO).
   */
  private findMatchingLane(call: PendingToolCall): Lane | null {
    let bestLane: Lane | null = null
    let bestTimestamp = Infinity

    for (const [, lane] of this.lanes) {
      for (const [, correlation] of lane.pendingCorrelations) {
        if (
          correlation.toolName === call.toolName &&
          deepEqual(correlation.args, call.args) &&
          correlation.timestamp < bestTimestamp
        ) {
          bestLane = lane
          bestTimestamp = correlation.timestamp
        }
      }
    }

    return bestLane
  }

  /** Remove the first matching correlation to prevent double-matching. */
  private consumeCorrelation(lane: Lane, call: PendingToolCall): void {
    for (const [id, correlation] of lane.pendingCorrelations) {
      if (
        correlation.toolName === call.toolName &&
        deepEqual(correlation.args, call.args)
      ) {
        lane.pendingCorrelations.delete(id)
        return
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal: buffering
  // -------------------------------------------------------------------------

  /**
   * Buffer an IPC call with no matching correlation yet.
   * The ACP notification may arrive slightly after the IPC call.
   * On timeout, falls back to the most recently registered lane.
   */
  private bufferCall(call: PendingToolCall): void {
    const timer = setTimeout(() => {
      const idx = this.bufferedCalls.findIndex((b) => b.call.callId === call.callId)
      if (idx !== -1) {
        this.bufferedCalls.splice(idx, 1)
        this.routeFallback(call)
      }
    }, CORRELATION_BUFFER_TIMEOUT_MS)

    this.bufferedCalls.push({ call, timestamp: Date.now(), timer })
  }

  private drainBufferedCalls(): void {
    let i = 0
    while (i < this.bufferedCalls.length) {
      const buffered = this.bufferedCalls[i]

      if (this.lanes.size === 1) {
        const [, lane] = [...this.lanes][0]
        clearTimeout(buffered.timer)
        this.bufferedCalls.splice(i, 1)
        this.consumeCorrelation(lane, buffered.call)
        lane.handler(buffered.call)
        continue
      }

      const match = this.findMatchingLane(buffered.call)
      if (match) {
        clearTimeout(buffered.timer)
        this.bufferedCalls.splice(i, 1)
        this.consumeCorrelation(match, buffered.call)
        match.handler(buffered.call)
      } else {
        i++
      }
    }
  }

  /** Fallback: route to the most recently registered lane. */
  private routeFallback(call: PendingToolCall): void {
    let lastLane: Lane | null = null
    for (const [, lane] of this.lanes) {
      lastLane = lane
    }

    if (lastLane) {
      lastLane.handler(call)
    }
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /** Discard stale correlations older than CORRELATION_MAX_AGE_MS. */
  cleanup(): void {
    const now = Date.now()
    for (const [, lane] of this.lanes) {
      for (const [id, correlation] of lane.pendingCorrelations) {
        if (now - correlation.timestamp > CORRELATION_MAX_AGE_MS) {
          lane.pendingCorrelations.delete(id)
        }
      }
    }
  }

  getLaneCount(): number {
    return this.lanes.size
  }

  getBufferedCallCount(): number {
    return this.bufferedCalls.length
  }

  clear(): void {
    for (const buffered of this.bufferedCalls) {
      clearTimeout(buffered.timer)
    }
    this.bufferedCalls.length = 0
    this.lanes.clear()
  }
}
