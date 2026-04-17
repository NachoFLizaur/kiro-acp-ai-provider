import { writeFileSync, readFileSync, mkdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { homedir } from "node:os"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersistedSession {
  kiroSessionId: string
  lastUsed: number
}

// ---------------------------------------------------------------------------
// XDG base path
// ---------------------------------------------------------------------------

function getXdgDataHome(): string {
  return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
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

/** Persist a session ID to disk (best-effort, failures silently ignored). */
export function persistSession(cwd: string, sessionId: string, affinityId?: string): void {
  try {
    const filePath = getSessionFilePath(cwd, affinityId)
    const dir = join(filePath, "..")
    mkdirSync(dir, { recursive: true })
    const data: PersistedSession = {
      kiroSessionId: sessionId,
      lastUsed: Date.now(),
    }
    writeFileSync(filePath, JSON.stringify(data), { mode: 0o600 })
  } catch {
    // Best-effort
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

    return data
  } catch {
    return null
  }
}
