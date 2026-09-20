import { writeFileSync, readFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs"
import { createHash, randomBytes } from "node:crypto"
import { join } from "node:path"
import { homedir } from "node:os"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersistedSession {
  kiroSessionId: string
  lastUsed: number
  /** `hashPromptMessages` output at the last dispatch to this kiro session. */
  delivered?: string[]
  /** sha1 of the system prompt text last delivered to this kiro session. */
  systemHash?: string
}

export interface DeliveredState {
  delivered: string[]
  systemHash?: string
}

// ---------------------------------------------------------------------------
// XDG base path
// ---------------------------------------------------------------------------

export function getXdgDataHome(): string {
  if (process.env.XDG_DATA_HOME) return process.env.XDG_DATA_HOME
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA
  return join(homedir(), ".local", "share")
}

// ---------------------------------------------------------------------------
// Session file path
// ---------------------------------------------------------------------------

const APP_DIR = "kiro-acp-ai-provider"
const SESSION_TTL_MS = 24 * 60 * 60 * 1000

function getSessionDir(cwd: string): string {
  const cwdHash = createHash("md5").update(cwd).digest("hex").slice(0, 8)
  return join(getXdgDataHome(), APP_DIR, "sessions", cwdHash)
}

export function getSessionFilePath(cwd: string, affinityId?: string): string {
  const sanitized = affinityId ? affinityId.replace(/[^a-zA-Z0-9_-]/g, "_") : undefined
  const fileName = sanitized ? `${sanitized}.json` : "_default.json"
  return join(getSessionDir(cwd), fileName)
}

// ---------------------------------------------------------------------------
// Persist / Load
// ---------------------------------------------------------------------------

/**
 * Persist a session ID to disk (best-effort, failures silently ignored).
 *
 * Without `state`, the delivered prefix already on disk is kept when the
 * kiro session id is unchanged (touching `lastUsed` must not forget what the
 * session has seen). A different session id starts with no prefix.
 */
export function persistSession(
  cwd: string,
  sessionId: string,
  affinityId?: string,
  state?: DeliveredState,
): void {
  try {
    const filePath = getSessionFilePath(cwd, affinityId)
    const dir = join(filePath, "..")
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const data: PersistedSession = {
      kiroSessionId: sessionId,
      lastUsed: Date.now(),
    }
    const carried = state ?? carriedState(filePath, sessionId)
    if (carried) {
      data.delivered = carried.delivered
      if (carried.systemHash !== undefined) data.systemHash = carried.systemHash
    }
    const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
    writeFileSync(tmpPath, JSON.stringify(data), { mode: 0o600 })
    renameSync(tmpPath, filePath)
  } catch {
    // Best-effort
  }
}

function carriedState(filePath: string, sessionId: string): DeliveredState | undefined {
  try {
    const existing = JSON.parse(readFileSync(filePath, "utf-8")) as PersistedSession
    if (existing.kiroSessionId !== sessionId || !Array.isArray(existing.delivered)) return undefined
    return { delivered: existing.delivered, systemHash: existing.systemHash }
  } catch {
    return undefined
  }
}

/**
 * Remove a persisted session mapping. Best-effort — silently ignores missing files.
 */
export function clearPersistedSession(cwd: string, affinityId?: string): void {
  const filePath = getSessionFilePath(cwd, affinityId)
  try {
    unlinkSync(filePath)
  } catch {
    // File doesn't exist or can't be removed — nothing to do
  }
}

/**
 * Load a persisted session from disk.
 * Returns null if missing, invalid, or older than 24 hours.
 */
export function loadPersistedSession(cwd: string, affinityId?: string): PersistedSession | null {
  try {
    const filePath = getSessionFilePath(cwd, affinityId)
    const raw = readFileSync(filePath, "utf-8")
    const data = JSON.parse(raw) as PersistedSession

    if (Date.now() - data.lastUsed > SESSION_TTL_MS) return null
    if (!data.kiroSessionId || typeof data.kiroSessionId !== "string") return null
    if (data.delivered !== undefined && !Array.isArray(data.delivered)) delete data.delivered
    if (data.systemHash !== undefined && typeof data.systemHash !== "string") delete data.systemHash

    return data
  } catch {
    return null
  }
}
