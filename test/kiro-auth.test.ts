import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import * as os from "node:os"
import * as childProcess from "node:child_process"
import { verifyAuth, resetAuthCache, type AuthStatus } from "../src/kiro-auth"

// ---------------------------------------------------------------------------
// verifyAuth() auth authority = `kiro-cli whoami --format json` (SDK 2.0.2).
//
// CORRECTS SDK 2.0.1: the on-disk token file `expiresAt` is NOT the live-auth
// signal (kiro-cli auto-re-authenticates and keeps the live token in the OS
// credential store), so the old file-expiry gate misclassified a logged-in user
// as expired. verifyAuth now derives `authenticated` SOLELY from the first
// "{"-line of `kiro-cli whoami --format json` requiring a non-empty
// `accountType`, and never consults the file's expiry. These tests mock
// execFileSync with the EMPIRICAL kiro-cli 2.7.1 fixtures (no real spawn, no
// backend) per the repo's bun-test conventions.
// ---------------------------------------------------------------------------

// EMPIRICAL FIXTURES (kiro-cli 2.7.1, captured on a real machine; verbatim).

// LOGGED-IN stdout: a single compact JSON line FOLLOWED by a NON-JSON "Profile:"
// trailer. EXIT=0. The parser must read ONLY the first "{"-line and ignore the
// trailer (never JSON.parse the whole stdout).
const WHOAMI_LOGGED_IN = `{"accountType":"IamIdentityCenter","email":"nflizaur+test@amazon.com","region":"eu-west-1","startUrl":"https://d-9367551e3b.awsapps.com/start"}

Profile:
KiroProfile-eu-central-1
arn:aws:codewhisperer:eu-central-1:375170955021:profile/AVPGDXYUY7AU`

// LOGGED-OUT stdout (right after `kiro-cli logout`): no `accountType`.
const WHOAMI_LOGGED_OUT = `{"account":null}`

const VERSION_STDOUT = "kiro-cli 2.7.1"

// Mock `execFileSync` so `verifyAuth()` sees controlled `--version` and
// `whoami --format json` output. A value is returned as stdout; an Error is
// thrown (spawn error / timeout). Returns the spy for restoration.
function mockKiroCli(opts: { version?: string | Error; whoami?: string | Error }) {
  const impl = (_file: string, args?: readonly string[]) => {
    const argv = args ?? []
    if (argv.includes("--version")) {
      if (opts.version instanceof Error) throw opts.version
      return opts.version ?? VERSION_STDOUT
    }
    if (argv.includes("whoami")) {
      if (opts.whoami instanceof Error) throw opts.whoami
      return opts.whoami ?? ""
    }
    return ""
  }
  return spyOn(childProcess, "execFileSync").mockImplementation(
    impl as unknown as typeof childProcess.execFileSync,
  )
}

describe("verifyAuth: whoami --format json detection rule", () => {
  const spies: Array<{ mockRestore: () => void }> = []
  const tempHomes: string[] = []

  // verifyAuth() memoizes for a short TTL, so without a reset one case's
  // AuthStatus would leak into the next. Drop the cache before each case.
  beforeEach(resetAuthCache)

  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore()
    while (tempHomes.length) {
      try { rmSync(tempHomes.pop()!, { recursive: true, force: true }) } catch {}
    }
  })

  /** Point `homedir()` at a fresh temp dir; return its path. */
  function mockHome(): string {
    const tempHome = mkdtempSync(join(os.tmpdir(), "kiro-home-"))
    tempHomes.push(tempHome)
    spies.push(spyOn(os, "homedir").mockReturnValue(tempHome))
    return tempHome
  }

  /** Write a stale token file under a mocked home; return its absolute path. */
  function writeStaleToken(tempHome: string): string {
    const cacheDir = join(tempHome, ".aws", "sso", "cache")
    mkdirSync(cacheDir, { recursive: true })
    const tokenPath = join(cacheDir, "kiro-auth-token.json")
    // Stale: the real expired value that triggered the 2.0.1 -32603 failures.
    writeFileSync(tokenPath, JSON.stringify({ expiresAt: "2025-04-01T00:00:00.000Z" }))
    return tokenPath
  }

  test("logged-in fixture WITH trailing Profile block => authenticated true (parser ignores the non-JSON trailer)", () => {
    spies.push(mockKiroCli({ whoami: WHOAMI_LOGGED_IN }))
    mockHome()
    const status = verifyAuth()
    expect(status.installed).toBe(true)
    expect(status.authenticated).toBe(true)
    expect(status.version).toBe(VERSION_STDOUT)
  })

  test('logged-out fixture {"account":null} => authenticated false', () => {
    spies.push(mockKiroCli({ whoami: WHOAMI_LOGGED_OUT }))
    mockHome()
    expect(verifyAuth().authenticated).toBe(false)
  })

  test("CORE REGRESSION: logged-in whoami WITH a STALE on-disk token file => authenticated true", () => {
    // SDK 2.0.1 would have flipped this to false via the file-expiry override.
    const tempHome = mockHome()
    const tokenPath = writeStaleToken(tempHome)
    spies.push(mockKiroCli({ whoami: WHOAMI_LOGGED_IN }))

    const status = verifyAuth()
    expect(status.authenticated).toBe(true) // stale expiresAt must NOT downgrade
    expect(status.tokenPath).toBe(tokenPath) // file still reported as a refresh source
  })

  test("logged-in whoami with a MISSING token file => authenticated true (file is not authoritative)", () => {
    mockHome() // no token file written under the temp home
    spies.push(mockKiroCli({ whoami: WHOAMI_LOGGED_IN }))

    const status = verifyAuth()
    expect(status.authenticated).toBe(true)
    expect(status.tokenPath).toBeUndefined()
  })

  test("does NOT decide on exit code alone: logged-in (EXIT=0) stays authenticated", () => {
    // execFileSync returns stdout (success/EXIT=0) for both fixtures; only the
    // parsed accountType distinguishes them, never the exit code.
    spies.push(mockKiroCli({ whoami: WHOAMI_LOGGED_IN }))
    mockHome()
    expect(verifyAuth().authenticated).toBe(true)
  })

  test("spawn error on whoami => authenticated false", () => {
    const err = Object.assign(new Error("spawn kiro-cli ENOENT"), { code: "ENOENT" })
    spies.push(mockKiroCli({ whoami: err }))
    mockHome()
    expect(verifyAuth().authenticated).toBe(false)
  })

  test("timeout on whoami => authenticated false", () => {
    const err = Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT", signal: "SIGTERM" })
    spies.push(mockKiroCli({ whoami: err }))
    mockHome()
    expect(verifyAuth().authenticated).toBe(false)
  })

  test("empty whoami output => authenticated false", () => {
    spies.push(mockKiroCli({ whoami: "" }))
    mockHome()
    expect(verifyAuth().authenticated).toBe(false)
  })

  test("non-JSON whoami output (no brace line) => authenticated false", () => {
    spies.push(mockKiroCli({ whoami: "error: not a terminal\nspinner..." }))
    mockHome()
    expect(verifyAuth().authenticated).toBe(false)
  })

  test("unparseable first brace-line => authenticated false", () => {
    spies.push(mockKiroCli({ whoami: "{not valid json" }))
    mockHome()
    expect(verifyAuth().authenticated).toBe(false)
  })

  test('whoami JSON with empty-string accountType => authenticated false', () => {
    spies.push(mockKiroCli({ whoami: '{"accountType":"   "}' }))
    mockHome()
    expect(verifyAuth().authenticated).toBe(false)
  })

  test("kiro-cli not installed (--version throws) => installed/authenticated false, never throws", () => {
    spies.push(mockKiroCli({ version: new Error("spawn kiro-cli ENOENT") }))
    let status: AuthStatus | undefined
    expect(() => {
      status = verifyAuth()
    }).not.toThrow()
    expect(status!.installed).toBe(false)
    expect(status!.authenticated).toBe(false)
  })

  test("timeout on --version still treats kiro-cli as installed and checks whoami", () => {
    const err = Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT", signal: "SIGTERM" })
    spies.push(mockKiroCli({ version: err, whoami: WHOAMI_LOGGED_IN }))
    mockHome()

    const status = verifyAuth()

    expect(status.installed).toBe(true)
    expect(status.authenticated).toBe(true)
    expect(status.version).toBeUndefined()
  })

  test("never throws and returns an AuthStatus value", () => {
    spies.push(mockKiroCli({ whoami: WHOAMI_LOGGED_OUT }))
    mockHome()
    let status: AuthStatus | undefined
    expect(() => {
      status = verifyAuth()
    }).not.toThrow()
    expect(status).toBeDefined()
    expect(typeof status!.installed).toBe("boolean")
    expect(typeof status!.authenticated).toBe("boolean")
  })
})
