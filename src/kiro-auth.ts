import { existsSync, readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

export interface AuthStatus {
  installed: boolean
  authenticated: boolean
  version?: string
  tokenPath?: string
}

/**
 * True when the cached token file exists, parses, and carries an `expiresAt`
 * timestamp strictly in the future.
 *
 * kiro-cli `whoami` reports "Logged in" off mere token PRESENCE, so an expired
 * token still looks authenticated to it; this is the expiry gate that catches
 * that case. A missing or unparseable `expiresAt` is treated as invalid
 * (safer than trusting a presence-only signal). Never throws.
 */
export function isTokenValid(tokenPath: string): boolean {
  try {
    const raw = readFileSync(tokenPath, "utf-8")
    const parsed = JSON.parse(raw) as { expiresAt?: unknown }
    const expiresAtMs =
      typeof parsed.expiresAt === "string" ? Date.parse(parsed.expiresAt) : NaN
    return Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()
  } catch {
    return false
  }
}

/** Check if kiro-cli is installed and authenticated. */
export function verifyAuth(): AuthStatus {
  let installed = false
  let version: string | undefined
  try {
    version = execFileSync("kiro-cli", ["--version"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    })
      .toString()
      .trim()
    installed = true
  } catch {
    return { installed: false, authenticated: false }
  }

  // Check actual auth status via kiro-cli (handles refresh token automatically)
  let authenticated = false
  try {
    const output = execFileSync("kiro-cli", ["whoami"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
    }).toString()
    authenticated = output.includes("Logged in")
  } catch {
    // whoami fails if not authenticated
  }

  const tokenPath = join(homedir(), ".aws", "sso", "cache", "kiro-auth-token.json")
  const hasToken = existsSync(tokenPath)

  // Expiry gate: kiro-cli `whoami` says "Logged in" even when the cached token
  // is expired, which routes prompts to a backend call that fails with a
  // cryptic -32603 "Internal error". Reject expired or unreadable tokens here
  // so consumers learn the truth early instead of looping on a doomed call.
  if (authenticated && !isTokenValid(tokenPath)) {
    authenticated = false
  }

  return {
    installed,
    authenticated,
    version,
    tokenPath: hasToken ? tokenPath : undefined,
  }
}
