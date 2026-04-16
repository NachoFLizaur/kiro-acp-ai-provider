import { writeFileSync, readFileSync, mkdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { homedir } from "node:os"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Persisted session data — minimal mapping per affinity slot. */
export interface PersistedSession {
  kiroSessionId: string
  lastUsed: number
}

// ---------------------------------------------------------------------------
// XDG base path resolution (~3 lines, no dependencies)
// ---------------------------------------------------------------------------

/**
 * Resolve the XDG data home directory.
 *
 * Uses `$XDG_DATA_HOME` if set, otherwise falls back to `$HOME/.local/share`.
 * This follows the XDG Base Directory Specification without any external deps.
 */
function getXdgDataHome(): string {
  return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
}

// ---------------------------------------------------------------------------
// Session file path
// ---------------------------------------------------------------------------

/** Application data directory under XDG data home. */
const APP_DIR = "kiro-acp-ai-provider"

/** Staleness TTL — sessions older than this are not loaded (24 hours). */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Get the directory for session files for a given working directory.
 *
 * Path: `{xdgDataHome}/kiro-acp-ai-provider/sessions/{cwdHash}/`
 */
function getSessionDir(cwd: string): string {
  const cwdHash = createHash("md5").update(cwd).digest("hex").slice(0, 8)
  return join(getXdgDataHome(), APP_DIR, "sessions", cwdHash)
}

/**
 * Get the full path to a session file.
 *
 * @param cwd - Working directory (hashed for the directory component)
 * @param affinityId - Session affinity identifier, or undefined for the default slot
 * @returns Path like `~/.local/share/kiro-acp-ai-provider/sessions/{cwdHash}/{affinityId}.json`
 */
export function getSessionFilePath(cwd: string, affinityId?: string): string {
  const fileName = affinityId ? `${affinityId}.json` : "_default.json"
  return join(getSessionDir(cwd), fileName)
}

// ---------------------------------------------------------------------------
// Persist / Load
// ---------------------------------------------------------------------------

/**
 * Persist a session ID to disk (best-effort, failures silently ignored).
 *
 * Writes minimal data: `{ kiroSessionId, lastUsed }`.
 * Creates the directory tree if it doesn't exist.
 */
export function persistSession(cwd: string, sessionId: string, affinityId?: string): void {
  try {
    const filePath = getSessionFilePath(cwd, affinityId)
    const dir = join(filePath, "..")
    mkdirSync(dir, { recursive: true })
    const data: PersistedSession = {
      kiroSessionId: sessionId,
      lastUsed: Date.now(),
    }
    writeFileSync(filePath, JSON.stringify(data))
  } catch {
    // Best-effort — ignore write failures
  }
}

/**
 * Try to load a previously persisted session from disk.
 *
 * Returns the persisted data if:
 * - The file exists and is valid JSON
 * - The session is not older than 24 hours (TTL check)
 *
 * Returns null otherwise (silently — caller creates a new session).
 */
export function loadPersistedSession(cwd: string, affinityId?: string): PersistedSession | null {
  try {
    const filePath = getSessionFilePath(cwd, affinityId)
    const raw = readFileSync(filePath, "utf-8")
    const data = JSON.parse(raw) as PersistedSession

    // Staleness check — don't load sessions older than 24h
    if (Date.now() - data.lastUsed > SESSION_TTL_MS) return null

    // Validate shape
    if (!data.kiroSessionId || typeof data.kiroSessionId !== "string") return null

    return data
  } catch {
    return null
  }
}
