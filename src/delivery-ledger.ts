/**
 * Re-send instructions on every fresh prompt at or above this percentage.
 * Kiro keeps the last 2 message pairs verbatim when compacting; carrying the
 * block near the compaction point keeps it in that recent-pair window.
 */
export const INSTRUCTION_DELIVERY_HIGH_WATER_PERCENT = 70

/** Immutable snapshot opened immediately before the prompt carrying the block. */
export interface InstructionDeliveryToken {
  readonly sessionId: string
  readonly text: string
  readonly generation: number
  readonly invalidation: number
  readonly epoch: number
  readonly sequence: number
}

interface SessionDelivery {
  proof?: InstructionDeliveryToken
  latest?: InstructionDeliveryToken
  inFlight: boolean
  invalidation: number
  lastUsage?: number
}

/**
 * In-memory proof of instruction delivery, owned by one ACPClient, not a model
 * or affinity key. Tokens are checked by identity as well as their snapshots,
 * so another client's token cannot acknowledge this client's session.
 * No promises or transport side effects are created here.
 */
export class InstructionDeliveryLedger {
  private readonly sessions = new Map<string, SessionDelivery>()
  private generation = 0
  private epoch = 0
  private sequence = 0

  /**
   * Read before building a fresh prompt. Only exact text with acknowledged,
   * current generation/invalidation/epoch proof can suppress the block. Missing or
   * uncertain proof and in-flight deliveries fail toward re-sending. Usage is
   * in percentage points (0–100); highWater overrides the default threshold.
   * Empty text disables delivery without reading or changing session state.
   */
  needsInstructions(
    sessionId: string,
    text: string,
    { highWater = INSTRUCTION_DELIVERY_HIGH_WATER_PERCENT }: { highWater?: number } = {},
  ): boolean {
    if (!text) return false
    const session = this.sessions.get(sessionId)
    const proof = session?.proof
    return !session || !proof || session.inFlight || proof.text !== text ||
      !this.isCurrent(proof, session) ||
      (session.lastUsage !== undefined && session.lastUsage >= highWater)
  }

  /**
   * Open immediately before sending a block (including one in history replay).
   * Different text irrevocably voids previous proof before recording the latest
   * token. Opening never acknowledges delivery. Callers skip empty text.
   */
  open(sessionId: string, text: string): InstructionDeliveryToken {
    const session = this.getSession(sessionId)
    if (session.proof?.text !== text) session.proof = undefined
    const token = Object.freeze({
      sessionId,
      text,
      generation: this.generation,
      invalidation: session.invalidation,
      epoch: this.epoch,
      sequence: ++this.sequence,
    })
    session.latest = token
    session.inFlight = true
    return token
  }

  /**
   * Call only when the token's own prompt resolves. Read latest-token identity
   * and generation/invalidation/epoch before writing proof; all must still match.
   * Cancelled, already settled, superseded or invalidated tokens cannot prove
   * delivery. Ignoring an older token never changes newer proof. Returns true
   * only when proof was written; a false result leaves the conservative resend
   * decision to needsInstructions. Abort/rejection callers use fail instead.
   */
  acknowledge(token: InstructionDeliveryToken, stopReason: string): boolean {
    if (stopReason === "cancelled") {
      this.fail(token)
      return false
    }
    const session = this.sessions.get(token.sessionId)
    if (!session || session.latest !== token || !session.inFlight || !this.isCurrent(token, session)) {
      return false
    }
    session.inFlight = false
    session.proof = token
    return true
  }

  /**
   * Settle a rejected or aborted delivery without restoring any voided proof.
   * Read token identity before mutation: late failures cannot affect newer
   * deliveries. Repeated settlement is ignored, including fail after success.
   */
  fail(token: InstructionDeliveryToken): void {
    const session = this.sessions.get(token.sessionId)
    if (session?.latest === token && session.inFlight) session.inFlight = false
  }

  /** Invalidate one session's proof and outstanding tokens, retaining usage. */
  invalidate(sessionId: string): void {
    const session = this.getSession(sessionId)
    session.invalidation++
    session.proof = undefined
  }

  /** Advance the client epoch when a completion cannot identify its session. */
  invalidateAll(): void {
    this.epoch++
  }

  /**
   * Store the last finite usage report solely for the high-water decision read
   * before a fresh prompt; never change delivery proof or outstanding tokens.
   * Kiro's start-of-turn values lag, so the high-water re-send may come one turn
   * late. Missing/non-finite reports disable this update before session mutation,
   * retaining the previous percentage (and any high-water re-send it requires).
   */
  recordUsage(sessionId: string, pct: number | undefined): void {
    if (typeof pct !== "number" || !Number.isFinite(pct)) return
    const session = this.getSession(sessionId)
    session.lastUsage = pct
  }

  /**
   * Call before every child-process spawn and at the beginning of resource
   * release. Clearing sessions also discards old-process usage; the monotonic
   * generation ensures late tokens cannot acknowledge a reloaded session id.
   */
  advanceGeneration(): void {
    this.generation++
    this.sessions.clear()
  }

  private isCurrent(token: InstructionDeliveryToken, session: SessionDelivery): boolean {
    return token.generation === this.generation && token.invalidation === session.invalidation &&
      token.epoch === this.epoch
  }

  private getSession(sessionId: string): SessionDelivery {
    let session = this.sessions.get(sessionId)
    if (!session) {
      session = { inFlight: false, invalidation: 0 }
      this.sessions.set(sessionId, session)
    }
    return session
  }
}
