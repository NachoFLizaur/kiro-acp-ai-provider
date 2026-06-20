import { existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

export interface AuthStatus {
  installed: boolean
  authenticated: boolean
  version?: string
  tokenPath?: string
}

// Bounded timeouts for the two synchronous probes. `--version` is a local print;
// `whoami` may do a network token refresh, so it keeps more margin. Generous
// enough that a slow-but-logged-in machine never reports logged-out.
const VERSION_TIMEOUT_MS = 3000
const WHOAMI_TIMEOUT_MS = 5000

// Short-TTL memoization of verifyAuth(). It runs two blocking spawns on the hot
// -32603 error path, so a burst of failures would otherwise re-spawn every time.
// TTL is short so a real login/logout is reflected almost immediately.
const AUTH_CACHE_TTL_MS = 5000
let authCache: { value: AuthStatus; expiresAt: number } | null = null

/** Drop the memoized verifyAuth() result so the next call re-probes. */
export function resetAuthCache(): void {
  authCache = null
}

/**
 * Extract the first balanced JSON object from text via brace matching.
 *
 * `whoami --format json` appends a non-JSON "Profile:" trailer, so we cannot
 * parse the whole output. String literals are tracked (with escape handling) so
 * a "}" inside a value cannot close the object early. Returns the object
 * substring, or null when there is no balanced close.
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{")
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === "{") {
      depth++
    } else if (ch === "}") {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null // no balanced close
}

/**
 * True IFF `text` has a parseable auth object with a non-empty `accountType`.
 * Logged out is `{"account":null}`; non-JSON/unparseable is treated as logged out.
 */
function hasAuthenticatedAccount(text: string): boolean {
  const json = extractFirstJsonObject(text)
  if (!json) return false
  try {
    const parsed = JSON.parse(json) as { accountType?: unknown }
    return typeof parsed.accountType === "string" && parsed.accountType.trim() !== ""
  } catch {
    return false // not valid JSON
  }
}

/**
 * Decide auth state from whoami output. stdout is primary; fall back to stderr
 * in case a future kiro-cli writes the JSON there.
 */
function parseWhoamiAuthenticated(stdout: string, stderr = ""): boolean {
  return hasAuthenticatedAccount(stdout) || hasAuthenticatedAccount(stderr)
}

/**
 * Spawn `kiro-cli --version` then `whoami --format json` and derive an
 * AuthStatus. Factored out of verifyAuth so the cache covers every return path.
 */
function probeAuth(): AuthStatus {
  const isWin = process.platform === "win32"

  let installed = false
  let version: string | undefined
  try {
    version = execFileSync("kiro-cli", ["--version"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: VERSION_TIMEOUT_MS,
      shell: isWin, // resolve kiro-cli.exe / PATHEXT on Windows
    })
      .toString()
      .trim()
    installed = true
  } catch {
    return { installed: false, authenticated: false }
  }

  // Authority = whoami --format json; require a non-empty accountType. We never
  // decide on exit code alone. On the throw path execFileSync attaches captured
  // stdout/stderr, so parse both before concluding logged-out.
  let authenticated = false
  try {
    const stdout = execFileSync("kiro-cli", ["whoami", "--format", "json"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: WHOAMI_TIMEOUT_MS,
      shell: isWin, // resolve kiro-cli.exe / PATHEXT on Windows
    }).toString()
    authenticated = parseWhoamiAuthenticated(stdout)
  } catch (err) {
    const e = err as { stdout?: Buffer | string | null; stderr?: Buffer | string | null }
    const out = e?.stdout != null ? e.stdout.toString() : ""
    const errOut = e?.stderr != null ? e.stderr.toString() : ""
    authenticated = parseWhoamiAuthenticated(out, errOut)
  }

  const tokenPath = join(homedir(), ".aws", "sso", "cache", "kiro-auth-token.json")
  const hasToken = existsSync(tokenPath)

  return {
    installed,
    authenticated,
    version,
    tokenPath: hasToken ? tokenPath : undefined,
  }
}

/**
 * Check whether kiro-cli is installed and the user is authenticated.
 *
 * Auth authority is `kiro-cli whoami --format json` ALONE. whoami abstracts the
 * per-OS credential store (Keychain / DPAPI / libsecret), so we never read any
 * OS credential store directly. The on-disk SSO token file is no longer
 * consulted for the auth decision: kiro-cli auto-re-authenticates, so a stale
 * file `expiresAt` is meaningless and previously misclassified a logged-in user
 * as expired. The returned `tokenPath` is reported only as an OPTIONAL refresh
 * source for consumers.
 *
 * Memoized for a short TTL (see authCache) and kept synchronous so callers are
 * untouched. Never throws.
 */
export function verifyAuth(): AuthStatus {
  if (authCache && Date.now() < authCache.expiresAt) {
    return authCache.value // fresh; reuse without re-spawning
  }
  const value = probeAuth()
  authCache = { value, expiresAt: Date.now() + AUTH_CACHE_TTL_MS }
  return value
}
