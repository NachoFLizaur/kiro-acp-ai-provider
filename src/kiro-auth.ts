import { existsSync } from "node:fs"
import { execFile, execFileSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

export interface AuthStatus {
  installed: boolean
  authenticated: boolean
  version?: string
  tokenPath?: string
}

// Bounded timeouts for the two synchronous probes. Cold Windows launches can be
// slow even for `--version`; `whoami` may also do a network token refresh.
const VERSION_TIMEOUT_MS = 10000
const WHOAMI_TIMEOUT_MS = 10000

// Short-TTL memoization of verifyAuth(). It runs two blocking spawns on the hot
// -32603 error path, so a burst of failures would otherwise re-spawn every time.
// TTL is short so a real login/logout is reflected almost immediately.
const AUTH_CACHE_TTL_MS = 5000
let authCache: { value: AuthStatus; expiresAt: number } | null = null

/**
 * Drop the memoized verifyAuth()/verifyAuthAsync() result so the next call
 * re-probes. Deliberately does not cancel an in-flight async probe; see
 * verifyAuthAsync: the probe still completes and re-memos its result.
 */
export function resetAuthCache(): void {
  authCache = null
}

/**
 * Extract the first balanced JSON object from text via brace matching.
 *
 * `whoami --format json` appends a non-JSON "Profile:" trailer, so the whole
 * output cannot be parsed. String literals are tracked (with escape handling) so
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
 * True if and only if `text` has a parseable auth object with a non-empty `accountType`.
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

function isTimeoutError(err: unknown): boolean {
  const e = err as { code?: unknown; signal?: unknown }
  return e?.code === "ETIMEDOUT" || e?.signal === "SIGTERM"
}

// ---------------------------------------------------------------------------
// Shared probe core. The sync (verifyAuth) and async (verifyAuthAsync) paths
// differ only in spawn mechanics (execFileSync vs callback execFile); every
// probe decision — version gate, whoami parse with throw-path recovery, and
// token-file existence — lives once in the derive* helpers below. The two
// drivers (probeAuth / probeAuthAsync) are deliberately thin, symmetric
// sequencers over those helpers (chosen over a generic sync/async core so the
// sync path stays genuinely synchronous without Promise indirection).
// ---------------------------------------------------------------------------

/** Result of one spawn attempt, normalized across the sync/async adapters. */
interface ExecOutcome {
  stdout: string
  stderr: string
  error: unknown // undefined on success
}

/**
 * Version step (install gate): success => installed with a trimmed version;
 * timeout => the command launched but did not answer quickly enough, so it is
 * not a missing install (version unknown); any other failure => not installed.
 */
function deriveVersionStep(outcome: ExecOutcome): { installed: boolean; version?: string } {
  if (outcome.error === undefined) return { installed: true, version: outcome.stdout.trim() }
  if (isTimeoutError(outcome.error)) return { installed: true }
  return { installed: false }
}

/**
 * Whoami step (auth authority): on success parse stdout alone; on failure
 * parse the captured stdout and stderr before concluding logged-out (kiro-cli
 * may exit non-zero while still printing the auth JSON). The exit code alone
 * never decides the outcome.
 */
function deriveAuthenticated(outcome: ExecOutcome): boolean {
  if (outcome.error === undefined) return parseWhoamiAuthenticated(outcome.stdout)
  return parseWhoamiAuthenticated(outcome.stdout, outcome.stderr)
}

/** Token-file step: report the path only when the file exists. */
function deriveTokenPath(): string | undefined {
  const tokenPath = join(homedir(), ".aws", "sso", "cache", "kiro-auth-token.json")
  return existsSync(tokenPath) ? tokenPath : undefined
}

/**
 * Sync exec adapter: execFileSync with the exact historical options. On the
 * throw path execFileSync attaches captured stdout/stderr to the error, so
 * they are read from the error object and coerced into the outcome.
 */
function execSyncOutcome(args: readonly string[], timeoutMs: number): ExecOutcome {
  try {
    const stdout = execFileSync("kiro-cli", args as string[], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
      shell: process.platform === "win32", // resolve kiro-cli.exe / PATHEXT on Windows
    }).toString()
    return { stdout, stderr: "", error: undefined }
  } catch (err) {
    const e = err as { stdout?: Buffer | string | null; stderr?: Buffer | string | null }
    return {
      stdout: e?.stdout != null ? e.stdout.toString() : "",
      stderr: e?.stderr != null ? e.stderr.toString() : "",
      error: err,
    }
  }
}

/**
 * Async exec adapter: callback-style execFile wrapped in a Promise (node
 * builtins only, so the package keeps zero runtime dependencies). The callback
 * delivers captured stdout/stderr even on error, and execFile's timeout kill
 * surfaces as `signal: "SIGTERM"`, which isTimeoutError already classifies.
 * Never rejects.
 */
function execAsyncOutcome(args: readonly string[], timeoutMs: number): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    execFile(
      "kiro-cli",
      args as string[],
      {
        timeout: timeoutMs,
        shell: process.platform === "win32", // win32 PATHEXT resolution; must match the sync probe
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          error: error ?? undefined,
        })
      },
    )
  })
}

/**
 * Spawn `kiro-cli --version` then `whoami --format json` and derive an
 * AuthStatus. Factored out of verifyAuth so the cache covers every return path.
 * Thin sync driver over the shared derive* decision helpers.
 */
function probeAuth(): AuthStatus {
  const versionStep = deriveVersionStep(execSyncOutcome(["--version"], VERSION_TIMEOUT_MS))
  if (!versionStep.installed) return { installed: false, authenticated: false }

  const authenticated = deriveAuthenticated(
    execSyncOutcome(["whoami", "--format", "json"], WHOAMI_TIMEOUT_MS),
  )

  return {
    installed: true,
    authenticated,
    version: versionStep.version,
    tokenPath: deriveTokenPath(),
  }
}

/**
 * Async twin of probeAuth: identical decisions via the same derive* helpers,
 * but the spawns go through the non-blocking execFile adapter. Never rejects.
 */
async function probeAuthAsync(): Promise<AuthStatus> {
  const versionStep = deriveVersionStep(await execAsyncOutcome(["--version"], VERSION_TIMEOUT_MS))
  if (!versionStep.installed) return { installed: false, authenticated: false }

  const authenticated = deriveAuthenticated(
    await execAsyncOutcome(["whoami", "--format", "json"], WHOAMI_TIMEOUT_MS),
  )

  return {
    installed: true,
    authenticated,
    version: versionStep.version,
    tokenPath: deriveTokenPath(),
  }
}

/**
 * Check whether kiro-cli is installed and the user is authenticated.
 *
 * Auth authority is `kiro-cli whoami --format json` alone. whoami abstracts the
 * per-OS credential store (Keychain / DPAPI / libsecret), so no OS credential
 * store is read directly. The on-disk SSO token file is not consulted for the
 * auth decision: kiro-cli auto-re-authenticates, so a stale file `expiresAt`
 * is meaningless and would misclassify a logged-in user as expired. The
 * returned `tokenPath` is reported only as an optional refresh source for
 * consumers.
 *
 * Memoized for a short TTL (see authCache) and kept synchronous so existing
 * callers are unaffected. Never throws.
 */
export function verifyAuth(): AuthStatus {
  if (authCache && Date.now() < authCache.expiresAt) {
    return authCache.value // fresh; reuse without re-spawning
  }
  const value = probeAuth()
  authCache = { value, expiresAt: Date.now() + AUTH_CACHE_TTL_MS }
  return value
}

// One in-flight async probe at a time. A caller polling every few seconds can
// easily outpace a probe that takes up to ~20s worst-case (2 spawns x 10s), so
// concurrent verifyAuthAsync() callers coalesce onto the same promise instead
// of stacking kiro-cli spawns.
let inflightProbe: Promise<AuthStatus> | null = null

/**
 * Async variant of verifyAuth(): identical probe, identical AuthStatus,
 * identical 5s memo (shared cache object with the sync path), but the two
 * kiro-cli spawns never block the event loop. Concurrent callers coalesce
 * onto one in-flight probe (see inflightProbe). Never rejects.
 *
 * Note: resetAuthCache() drops the memo but deliberately leaves an in-flight
 * probe untouched; it still completes and re-memos its result.
 */
export async function verifyAuthAsync(): Promise<AuthStatus> {
  if (authCache && Date.now() < authCache.expiresAt) return authCache.value
  if (inflightProbe) return inflightProbe
  inflightProbe = (async () => {
    try {
      const value = await probeAuthAsync()
      authCache = { value, expiresAt: Date.now() + AUTH_CACHE_TTL_MS }
      return value
    } finally {
      inflightProbe = null
    }
  })()
  return inflightProbe
}
