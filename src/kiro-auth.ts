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

// Bounded timeout for the whoami auth probe. whoami may perform a network
// refresh, so it must never block or hang process startup.
const WHOAMI_TIMEOUT_MS = 8000

/**
 * Decide auth state from `kiro-cli whoami --format json` stdout.
 *
 * The logged-in output appends a NON-JSON "Profile:\n<name>\n<arn>" trailer
 * after the JSON line, so we never JSON.parse the whole stdout. Take the FIRST
 * line whose trimmed text starts with "{" and parse THAT line only.
 *
 * authenticated is true IFF the parse succeeds AND `accountType` is a non-empty
 * string (e.g. "IamIdentityCenter"). Logged out is `{"account":null}` (no
 * accountType). Empty / non-JSON / no-brace output is treated as logged out.
 * Never throws.
 */
function parseWhoamiAuthenticated(stdout: string): boolean {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith("{"))
  if (!line) return false // no JSON object line (covers empty / non-JSON output)
  try {
    const parsed = JSON.parse(line) as { accountType?: unknown }
    return typeof parsed.accountType === "string" && parsed.accountType.trim() !== ""
  } catch {
    return false // unparseable first line
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
 * source for consumers. Never throws.
 */
export function verifyAuth(): AuthStatus {
  const isWin = process.platform === "win32"

  let installed = false
  let version: string | undefined
  try {
    version = execFileSync("kiro-cli", ["--version"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
      shell: isWin, // resolve kiro-cli.exe / PATHEXT on Windows
    })
      .toString()
      .trim()
    installed = true
  } catch {
    return { installed: false, authenticated: false }
  }

  // Authority = kiro-cli whoami --format json. Parse the first "{"-line only and
  // require a non-empty accountType (see parseWhoamiAuthenticated). A spawn
  // error or a timeout means NOT authenticated; we never decide on the exit code
  // alone (logged-in is EXIT=0; the logged-out exit code is unconfirmed).
  let authenticated = false
  try {
    const stdout = execFileSync("kiro-cli", ["whoami", "--format", "json"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: WHOAMI_TIMEOUT_MS,
      shell: isWin, // resolve kiro-cli.exe / PATHEXT on Windows
    }).toString()
    authenticated = parseWhoamiAuthenticated(stdout)
  } catch {
    authenticated = false
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
