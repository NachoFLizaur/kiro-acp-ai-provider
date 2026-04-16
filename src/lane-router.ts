// ---------------------------------------------------------------------------
// Lane Router — Per-session tool call routing for concurrent doStream() calls
// ---------------------------------------------------------------------------
//
// Routes IPC tool calls (from the MCP bridge) to the correct doStream() call's
// stream by correlating them with ACP session/update notifications.
//
// Each active doStream() call registers a "lane" with its sessionId and a
// handler callback. When an ACP tool_call notification arrives, it creates a
// "correlation" entry. When the IPC tool call arrives, the router matches it
// to the correct lane using toolName + args deep equality.
//
// Single-lane fast path: when only one lane is registered (the common case),
// correlation matching is skipped entirely — the call goes directly to the
// only lane.
// ---------------------------------------------------------------------------

import type { PendingToolCall } from "./ipc-server"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A pending correlation entry from an ACP session/update notification. */
export interface PendingCorrelation {
  /** kiro-cli's tool call ID (from ACP notification). */
  toolCallId: string
  /** Tool name to match against IPC calls. */
  toolName: string
  /** Tool arguments to match against IPC calls (deep equality). */
  args: Record<string, unknown>
  /** Timestamp when the correlation was registered (for tiebreaking). */
  timestamp: number
}

/** A lane represents one active doStream() call's tool call handling context. */
interface Lane {
  /** ACP session ID that owns this lane. */
  sessionId: string
  /** Callback that writes tool-call parts to this lane's stream. */
  handler: (call: PendingToolCall) => void
  /** Pending correlations from ACP notifications, keyed by toolCallId. */
  pendingCorrelations: Map<string, PendingCorrelation>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout for buffered IPC calls waiting for a correlation match. */
const CORRELATION_BUFFER_TIMEOUT_MS = 2_000

/** Maximum age for a pending correlation before it's discarded. */
const CORRELATION_MAX_AGE_MS = 30_000

// ---------------------------------------------------------------------------
// Deep equality helpers
// ---------------------------------------------------------------------------

/** Recursively sort object keys for deterministic serialization. */
function sortKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj
  if (Array.isArray(obj)) return obj.map(sortKeys)
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((obj as Record<string, unknown>)[key])
  }
  return sorted
}

/**
 * Deep equality check for tool arguments.
 *
 * Compares two argument objects by serializing to JSON. This is sufficient
 * because tool arguments are plain JSON objects (no functions, dates, etc.).
 * The serialization normalizes key ordering.
 */
function deepEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
}

// ---------------------------------------------------------------------------
// LaneRouter
// ---------------------------------------------------------------------------

export class LaneRouter {
  /** Active lanes, keyed by sessionId. */
  private readonly lanes = new Map<string, Lane>()

  /** IPC calls that arrived before a matching correlation. */
  private readonly bufferedCalls: Array<{
    call: PendingToolCall
    timestamp: number
    timer: ReturnType<typeof setTimeout>
  }> = []

  // -------------------------------------------------------------------------
  // Lane lifecycle
  // -------------------------------------------------------------------------

  /**
   * Register a lane for a doStream() call.
   *
   * Called at the start of startFreshPrompt() and resumeWithToolResults().
   * The handler receives PendingToolCall objects routed to this session.
   */
  register(sessionId: string, handler: (call: PendingToolCall) => void): void {
    this.lanes.set(sessionId, {
      sessionId,
      handler,
      pendingCorrelations: new Map(),
    })

    // Check if any buffered IPC calls now match this lane
    this.drainBufferedCalls()
  }

  /**
   * Unregister a lane when a doStream() call completes or errors.
   *
   * Cleans up pending correlations. Does NOT reject buffered IPC calls —
   * they may match a different lane or the fallback.
   */
  unregister(sessionId: string): void {
    this.lanes.delete(sessionId)
  }

  /**
   * Update the handler for an existing lane.
   *
   * Used during resumption: the lane stays registered (same session),
   * but the handler changes to write to the new stream.
   */
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
   * Record a pending correlation from an ACP session/update tool_call notification.
   *
   * Called by the adapter's onUpdate handler when it sees a tool_call notification.
   * This creates a "reservation" that the next matching IPC call should be routed
   * to this session's lane.
   */
  correlate(
    sessionId: string,
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): void {
    const lane = this.lanes.get(sessionId)
    if (!lane) return // Lane not registered — ignore (shouldn't happen)

    lane.pendingCorrelations.set(toolCallId, {
      toolCallId,
      toolName,
      args,
      timestamp: Date.now(),
    })

    // Check if any buffered IPC calls now match this correlation
    this.drainBufferedCalls()
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  /**
   * Route an IPC /tool/pending call to the correct lane.
   *
   * Called by the IPC server when POST /tool/pending arrives.
   * Searches all lanes for a matching pending correlation.
   */
  route(call: PendingToolCall): void {
    // Fast path: only one lane registered → skip correlation
    if (this.lanes.size === 1) {
      const [, lane] = [...this.lanes][0]
      this.consumeCorrelation(lane, call)
      lane.handler(call)
      return
    }

    // No lanes registered — buffer the call
    if (this.lanes.size === 0) {
      this.bufferCall(call)
      return
    }

    // Search all lanes for a matching correlation
    const match = this.findMatchingLane(call)
    if (match) {
      this.consumeCorrelation(match, call)
      match.handler(call)
      return
    }

    // No match yet — buffer the call and wait for a correlation to arrive
    this.bufferCall(call)
  }

  // -------------------------------------------------------------------------
  // Internal: matching
  // -------------------------------------------------------------------------

  /**
   * Find a lane with a pending correlation matching the given IPC call.
   *
   * Matches on toolName + args (deep equality). If multiple lanes match
   * (identical tool calls from different sessions), uses the oldest
   * correlation timestamp as a tiebreaker (FIFO ordering).
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

  /**
   * Remove the consumed correlation from the lane.
   *
   * Finds and removes the first correlation matching the call's
   * toolName + args. This prevents the same correlation from being
   * matched twice.
   */
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
   * Buffer an IPC call that has no matching correlation yet.
   *
   * The ACP notification may arrive slightly after the IPC call.
   * We hold the call for up to CORRELATION_BUFFER_TIMEOUT_MS, re-checking
   * whenever a new correlation is registered.
   *
   * If the timeout fires with no match, fall back to the most recently
   * registered lane (best-effort routing).
   */
  private bufferCall(call: PendingToolCall): void {
    const timer = setTimeout(() => {
      // Timeout — remove from buffer and use fallback
      const idx = this.bufferedCalls.findIndex((b) => b.call.callId === call.callId)
      if (idx !== -1) {
        this.bufferedCalls.splice(idx, 1)
        this.routeFallback(call)
      }
    }, CORRELATION_BUFFER_TIMEOUT_MS)

    this.bufferedCalls.push({ call, timestamp: Date.now(), timer })
  }

  /**
   * Try to drain buffered IPC calls against current correlations.
   *
   * Called when a new correlation is registered or a new lane is added.
   */
  private drainBufferedCalls(): void {
    // Iterate in order (oldest first) to preserve FIFO
    let i = 0
    while (i < this.bufferedCalls.length) {
      const buffered = this.bufferedCalls[i]

      // Single-lane fast path for buffered calls too
      if (this.lanes.size === 1) {
        const [, lane] = [...this.lanes][0]
        clearTimeout(buffered.timer)
        this.bufferedCalls.splice(i, 1)
        this.consumeCorrelation(lane, buffered.call)
        lane.handler(buffered.call)
        // Don't increment i — array shifted
        continue
      }

      const match = this.findMatchingLane(buffered.call)
      if (match) {
        clearTimeout(buffered.timer)
        this.bufferedCalls.splice(i, 1)
        this.consumeCorrelation(match, buffered.call)
        match.handler(buffered.call)
        // Don't increment i — array shifted
      } else {
        i++
      }
    }
  }

  /**
   * Fallback routing when no correlation match is found after timeout.
   *
   * Routes to the most recently registered lane. This handles the case
   * where the ACP notification was missed or delayed beyond the buffer
   * timeout.
   */
  private routeFallback(call: PendingToolCall): void {
    // Pick the last registered lane (most recent doStream)
    let lastLane: Lane | null = null
    for (const [, lane] of this.lanes) {
      lastLane = lane
    }

    if (lastLane) {
      lastLane.handler(call)
    }
    // If no lanes registered, the call is dropped.
    // This shouldn't happen — if there are no active doStream() calls,
    // there shouldn't be any tool calls arriving.
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /**
   * Clean up stale correlations older than CORRELATION_MAX_AGE_MS.
   *
   * Called periodically or on lane unregister. Prevents memory leaks
   * from correlations that were never matched (e.g., tool call was
   * cancelled before reaching the MCP bridge).
   */
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

  /** Get the number of active lanes (for diagnostics). */
  getLaneCount(): number {
    return this.lanes.size
  }

  /** Get the number of buffered IPC calls (for diagnostics). */
  getBufferedCallCount(): number {
    return this.bufferedCalls.length
  }

  /** Clear all lanes and buffered calls (for shutdown). */
  clear(): void {
    for (const buffered of this.bufferedCalls) {
      clearTimeout(buffered.timer)
    }
    this.bufferedCalls.length = 0
    this.lanes.clear()
  }
}
