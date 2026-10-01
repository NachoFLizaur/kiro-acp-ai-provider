import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import * as os from "node:os"
import * as childProcess from "node:child_process"
import { verifyAuth, verifyAuthAsync, resetAuthCache, type AuthStatus } from "../src/kiro-auth"

// ---------------------------------------------------------------------------
// verifyAuth() detection rule: `kiro-cli whoami --format json` is the sole auth
// authority. `authenticated` is derived from the first balanced JSON object in
// the whoami output and requires a non-empty `accountType`. The on-disk token
// file's `expiresAt` is never consulted: kiro-cli auto-re-authenticates and
// keeps the live token in the OS credential store, so file expiry says nothing
// about the live session. These tests mock execFileSync with fixtures captured
// from kiro-cli 2.7.1 (no real spawn, no backend), following the repo's
// bun-test conventions.
// ---------------------------------------------------------------------------

// Fixtures captured from kiro-cli 2.7.1 (verbatim shape; identifiers are
// example values).

// Logged-in stdout: a single compact JSON line followed by a non-JSON "Profile:"
// trailer, exit 0. The parser must read only the first balanced JSON object and
// ignore the trailer (never JSON.parse the whole stdout).
const WHOAMI_LOGGED_IN = `{"accountType":"IamIdentityCenter","email":"user@example.com","region":"eu-west-1","startUrl":"https://d-0000000000.awsapps.com/start"}

Profile:
KiroProfile-eu-central-1
arn:aws:codewhisperer:eu-central-1:123456789012:profile/EXAMPLEPROFILE`

// Logged-out stdout (right after `kiro-cli logout`): no `accountType`.
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

// --- Async sibling of mockKiroCli -------------------------------------------
// verifyAuthAsync() spawns via callback-style `execFile`, so this helper spies
// on childProcess.execFile, routes on argv, and delivers (error, stdout,
// stderr) through the Node callback. A behavior can be a plain string (stdout,
// success), an Error (failure with empty streams), or `{ error, stdout?,
// stderr? }` (failure with captured output, the throw-path recovery shape).
// An optional `gate` promise delays every callback until manually released
// (used by the coalescing test to hold two callers in flight).

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void

type AsyncCliBehavior = string | Error | { error: Error; stdout?: string; stderr?: string }

interface RecordedExecFileCall {
  file: string
  args: readonly string[]
  options: Record<string, unknown> | undefined
}

function mockKiroCliAsync(opts: {
  version?: AsyncCliBehavior
  whoami?: AsyncCliBehavior
  gate?: Promise<unknown>
}) {
  const calls: RecordedExecFileCall[] = []

  const respond = (argv: readonly string[], callback: ExecFileCallback) => {
    const behavior = argv.includes("--version")
      ? opts.version ?? VERSION_STDOUT
      : argv.includes("whoami")
        ? opts.whoami ?? ""
        : ""
    if (behavior instanceof Error) callback(behavior, "", "")
    else if (typeof behavior === "string") callback(null, behavior, "")
    else callback(behavior.error, behavior.stdout ?? "", behavior.stderr ?? "")
  }

  // Defensive over execFile's overloads: the callback is always the last
  // argument; options (when present) sit between args and the callback.
  const impl = (file: string, ...rest: unknown[]) => {
    const callback = rest[rest.length - 1] as ExecFileCallback
    const args = (Array.isArray(rest[0]) ? rest[0] : []) as readonly string[]
    const maybeOptions =
      rest.length >= 3 && rest[1] !== null && typeof rest[1] === "object" && !Array.isArray(rest[1])
        ? (rest[1] as Record<string, unknown>)
        : undefined
    calls.push({ file, args, options: maybeOptions })
    const deliver = () => respond(args, callback)
    if (opts.gate) void opts.gate.then(deliver)
    else queueMicrotask(deliver) // always async, like the real execFile
    return undefined as unknown as ReturnType<typeof childProcess.execFile>
  }

  const spy = spyOn(childProcess, "execFile").mockImplementation(
    impl as unknown as typeof childProcess.execFile,
  )
  return { spy, calls }
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
    // Stale: an `expiresAt` well in the past, the shape that a file-expiry gate
    // would wrongly classify as logged out.
    writeFileSync(tokenPath, JSON.stringify({ expiresAt: "2025-04-01T00:00:00.000Z" }))
    return tokenPath
  }

  test("logged-in fixture with trailing Profile block => authenticated true (parser ignores the non-JSON trailer)", () => {
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

  test("logged-in whoami with a stale on-disk token file => authenticated true", () => {
    // A file-expiry gate would flip this to false; whoami is authoritative.
    const tempHome = mockHome()
    const tokenPath = writeStaleToken(tempHome)
    spies.push(mockKiroCli({ whoami: WHOAMI_LOGGED_IN }))

    const status = verifyAuth()
    expect(status.authenticated).toBe(true) // stale expiresAt must not downgrade
    expect(status.tokenPath).toBe(tokenPath) // file still reported as a refresh source
  })

  test("logged-in whoami with a missing token file => authenticated true (file is not authoritative)", () => {
    mockHome() // no token file written under the temp home
    spies.push(mockKiroCli({ whoami: WHOAMI_LOGGED_IN }))

    const status = verifyAuth()
    expect(status.authenticated).toBe(true)
    expect(status.tokenPath).toBeUndefined()
  })

  test("does not decide on exit code alone: logged-in (exit 0) stays authenticated", () => {
    // execFileSync returns stdout (success, exit 0) for both fixtures; only the
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

  // --- inconclusive: whoami never answered ------------------------------------
  // Sync twin of the async cases below; both paths share one classifier.

  describe("inconclusive marker (sync)", () => {
    test("whoami timeout => authenticated false, inconclusive true", () => {
      const err = Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT", signal: "SIGTERM" })
      spies.push(mockKiroCli({ whoami: err }))
      mockHome()

      const status = verifyAuth()

      expect(status.installed).toBe(true)
      expect(status.authenticated).toBe(false)
      expect(status.inconclusive).toBe(true)
    })

    test("whoami spawn error (string code, no exit status) => inconclusive true", () => {
      // execFileSync reports a failed spawn with a string code and a null status
      const err = Object.assign(new Error("spawn kiro-cli EACCES"), { code: "EACCES", status: null })
      spies.push(mockKiroCli({ whoami: err }))
      mockHome()

      const status = verifyAuth()

      expect(status.installed).toBe(true)
      expect(status.authenticated).toBe(false)
      expect(status.inconclusive).toBe(true)
    })

    test("whoami non-zero exit with logged-out output => definitive, no inconclusive key", () => {
      // kiro-cli ran and answered; the exit code alone never decides
      const err = Object.assign(new Error("Command failed: kiro-cli whoami"), {
        status: 1,
        stdout: Buffer.from(WHOAMI_LOGGED_OUT),
        stderr: Buffer.from(""),
      })
      spies.push(mockKiroCli({ whoami: err }))
      mockHome()

      const status = verifyAuth()

      expect(status.installed).toBe(true)
      expect(status.authenticated).toBe(false)
      expect("inconclusive" in status).toBe(false)
    })

    test("whoami non-zero exit with logged-in output => authenticated, no inconclusive key", () => {
      const err = Object.assign(new Error("Command failed: kiro-cli whoami"), {
        status: 2,
        stdout: Buffer.from(""),
        stderr: Buffer.from(WHOAMI_LOGGED_IN),
      })
      spies.push(mockKiroCli({ whoami: err }))
      mockHome()

      const status = verifyAuth()

      expect(status.authenticated).toBe(true)
      expect("inconclusive" in status).toBe(false)
    })

    test("definitive JSON answers carry no inconclusive key", () => {
      mockHome()
      const loggedOut = mockKiroCli({ whoami: WHOAMI_LOGGED_OUT })
      expect("inconclusive" in verifyAuth()).toBe(false)
      loggedOut.mockRestore()

      resetAuthCache()
      spies.push(mockKiroCli({ whoami: WHOAMI_LOGGED_IN }))
      expect("inconclusive" in verifyAuth()).toBe(false)
    })

    test("version timeout => installed true and whoami decides, including its inconclusive verdict", () => {
      const timeout = Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT", signal: "SIGTERM" })
      mockHome()
      const answered = mockKiroCli({ version: timeout, whoami: WHOAMI_LOGGED_OUT })
      const definitive = verifyAuth()
      expect(definitive.installed).toBe(true)
      expect(definitive.authenticated).toBe(false)
      expect("inconclusive" in definitive).toBe(false)
      answered.mockRestore()

      resetAuthCache()
      spies.push(mockKiroCli({ version: timeout, whoami: timeout }))
      const undecided = verifyAuth()
      expect(undecided.installed).toBe(true)
      expect(undecided.inconclusive).toBe(true)
    })

    test("any other version failure => installed false and never inconclusive", () => {
      const err = Object.assign(new Error("spawn kiro-cli ENOENT"), { code: "ENOENT", status: null })
      spies.push(mockKiroCli({ version: err, whoami: WHOAMI_LOGGED_IN }))
      mockHome()

      expect(verifyAuth()).toEqual({ installed: false, authenticated: false })
    })
  })
})

// ---------------------------------------------------------------------------
// verifyAuthAsync(): the additive async twin of verifyAuth(). These tests cover
// probe equivalence across the fixture matrix, the shared 5s memo (both
// directions), in-flight coalescing, the never-rejects contract, the verbatim
// 10s timeouts, and win32 `shell` resolution on the async spawns. Same
// no-real-spawn conventions as above, with execFile mocked via mockKiroCliAsync.
//
// Not asserted here (deliberate): resetAuthCache() does not cancel an in-flight
// async probe; the probe completes and re-memos its result.
// ---------------------------------------------------------------------------

describe("verifyAuthAsync: async probe, shared memo, coalescing", () => {
  const spies: Array<{ mockRestore: () => void }> = []
  const tempHomes: string[] = []

  // Both paths share one memo, so every case starts from a cold cache.
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

  /** Write a token file under a mocked home; return its absolute path. */
  function writeToken(tempHome: string): string {
    const cacheDir = join(tempHome, ".aws", "sso", "cache")
    mkdirSync(cacheDir, { recursive: true })
    const tokenPath = join(cacheDir, "kiro-auth-token.json")
    writeFileSync(tokenPath, JSON.stringify({ expiresAt: "2025-04-01T00:00:00.000Z" }))
    return tokenPath
  }

  /** Install the execFile mock and register its spy for restoration. */
  function mockAsync(opts: Parameters<typeof mockKiroCliAsync>[0]) {
    const mocked = mockKiroCliAsync(opts)
    spies.push(mocked.spy)
    return mocked
  }

  // --- probe matrix (equivalence with the sync fixture behavior) ------------

  test("logged-in fixture resolves installed+authenticated with the trimmed version", async () => {
    mockHome()
    mockAsync({ whoami: WHOAMI_LOGGED_IN })

    const status = await verifyAuthAsync()

    expect(status.installed).toBe(true)
    expect(status.authenticated).toBe(true)
    expect(status.version).toBe(VERSION_STDOUT)
  })

  test("logged-out fixture resolves authenticated:false", async () => {
    mockHome()
    mockAsync({ whoami: WHOAMI_LOGGED_OUT })

    const status = await verifyAuthAsync()

    expect(status.installed).toBe(true)
    expect(status.authenticated).toBe(false)
  })

  test("version spawn error resolves installed:false and never spawns whoami", async () => {
    mockHome()
    const err = Object.assign(new Error("spawn kiro-cli ENOENT"), { code: "ENOENT" })
    const { calls } = mockAsync({ version: err })

    const status = await verifyAuthAsync()

    expect(status).toEqual({ installed: false, authenticated: false })
    expect(calls.filter((c) => c.args.includes("whoami")).length).toBe(0)
  })

  test("version timeout (SIGTERM) still probes whoami: installed:true, version undefined", async () => {
    mockHome()
    const err = Object.assign(new Error("Command timed out"), { killed: true, signal: "SIGTERM" })
    const { calls } = mockAsync({ version: err, whoami: WHOAMI_LOGGED_IN })

    const status = await verifyAuthAsync()

    expect(status.installed).toBe(true)
    expect(status.authenticated).toBe(true)
    expect(status.version).toBeUndefined()
    expect(calls.filter((c) => c.args.includes("whoami")).length).toBe(1)
  })

  test("whoami error path recovers logged-in JSON from captured stdout", async () => {
    mockHome()
    const err = Object.assign(new Error("exit 1"), { code: 1 })
    mockAsync({ whoami: { error: err, stdout: WHOAMI_LOGGED_IN } })

    expect((await verifyAuthAsync()).authenticated).toBe(true)
  })

  test("whoami error path recovers logged-in JSON from captured stderr", async () => {
    mockHome()
    const err = Object.assign(new Error("exit 1"), { code: 1 })
    mockAsync({ whoami: { error: err, stderr: WHOAMI_LOGGED_IN } })

    expect((await verifyAuthAsync()).authenticated).toBe(true)
  })

  test("never rejects: both spawns error pathologically", async () => {
    mockHome()
    // Pathological: no code, no signal, no captured output on either spawn.
    mockAsync({ version: new Error("boom"), whoami: new Error("kaboom") })

    await expect(verifyAuthAsync()).resolves.toEqual({ installed: false, authenticated: false })
  })

  test("tokenPath is reported only when the token file exists", async () => {
    const tempHome = mockHome()
    mockAsync({ whoami: WHOAMI_LOGGED_IN })

    const without = await verifyAuthAsync()
    expect(without.tokenPath).toBeUndefined()

    resetAuthCache() // force a re-probe; the memo would otherwise short-circuit
    const tokenPath = writeToken(tempHome)
    const withToken = await verifyAuthAsync()
    expect(withToken.tokenPath).toBe(tokenPath)
  })

  // --- shared 5s memo (both directions) --------------------------------------

  test("memo shared sync->async: async call within TTL spawns nothing and matches", async () => {
    mockHome()
    spies.push(mockKiroCli({ whoami: WHOAMI_LOGGED_IN }))
    const syncStatus = verifyAuth()

    const { calls } = mockAsync({ whoami: WHOAMI_LOGGED_OUT }) // would flip the result if spawned
    const asyncStatus = await verifyAuthAsync()

    expect(calls.length).toBe(0)
    expect(asyncStatus).toEqual(syncStatus)
    expect(asyncStatus.authenticated).toBe(true)
  })

  test("memo shared async->sync: sync call within TTL spawns nothing and matches", async () => {
    mockHome()
    mockAsync({ whoami: WHOAMI_LOGGED_IN })
    const asyncStatus = await verifyAuthAsync()

    const syncSpy = mockKiroCli({ whoami: WHOAMI_LOGGED_OUT }) // would flip the result if spawned
    spies.push(syncSpy)
    const syncStatus = verifyAuth()

    expect(syncSpy).toHaveBeenCalledTimes(0)
    expect(syncStatus).toEqual(asyncStatus)
    expect(syncStatus.authenticated).toBe(true)
  })

  // --- in-flight coalescing --------------------------------------------------

  test("concurrent verifyAuthAsync calls coalesce onto one spawn pair", async () => {
    mockHome()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { calls } = mockAsync({ whoami: WHOAMI_LOGGED_IN, gate })

    // Both callers in flight before any callback fires.
    const first = verifyAuthAsync()
    const second = verifyAuthAsync()
    release()
    const [a, b] = await Promise.all([first, second])

    expect(calls.filter((c) => c.args.includes("--version")).length).toBe(1)
    expect(calls.filter((c) => c.args.includes("whoami")).length).toBe(1)
    expect(calls.length).toBe(2) // exactly one version+whoami pair
    expect(a).toEqual(b)
    expect(a.authenticated).toBe(true)
  })

  // --- fresh: memo bypass that still coalesces and refreshes the shared memo --

  describe("fresh option", () => {
    test("default call within the TTL reads the memo and spawns nothing", async () => {
      mockHome()
      const warm = mockAsync({ whoami: WHOAMI_LOGGED_IN })
      await verifyAuthAsync()
      warm.spy.mockRestore()

      const { calls } = mockAsync({ whoami: WHOAMI_LOGGED_OUT }) // would flip the result if spawned
      const status = await verifyAuthAsync()

      expect(calls.length).toBe(0)
      expect(status.authenticated).toBe(true)
    })

    test("fresh: false behaves exactly like the default", async () => {
      mockHome()
      const warm = mockAsync({ whoami: WHOAMI_LOGGED_IN })
      await verifyAuthAsync()
      warm.spy.mockRestore()

      const { calls } = mockAsync({ whoami: WHOAMI_LOGGED_OUT })
      const status = await verifyAuthAsync({ fresh: false })

      expect(calls.length).toBe(0)
      expect(status.authenticated).toBe(true)
    })

    test("fresh: true bypasses a warm memo and runs a new probe", async () => {
      // Arrange: memo says logged in; kiro-cli has since logged out
      mockHome()
      const warm = mockAsync({ whoami: WHOAMI_LOGGED_IN })
      const memoized = await verifyAuthAsync()
      expect(memoized.authenticated).toBe(true)
      warm.spy.mockRestore()

      // Act
      const { calls } = mockAsync({ whoami: WHOAMI_LOGGED_OUT })
      const status = await verifyAuthAsync({ fresh: true })

      // Assert: one new version+whoami pair, and the answer reflects it
      expect(calls.filter((c) => c.args.includes("--version")).length).toBe(1)
      expect(calls.filter((c) => c.args.includes("whoami")).length).toBe(1)
      expect(status.authenticated).toBe(false)
    })

    test("fresh: true overwrites the shared memo that a following default call reads", async () => {
      mockHome()
      const warm = mockAsync({ whoami: WHOAMI_LOGGED_IN })
      await verifyAuthAsync()
      warm.spy.mockRestore()

      const refreshed = mockAsync({ whoami: WHOAMI_LOGGED_OUT })
      const fresh = await verifyAuthAsync({ fresh: true })
      refreshed.spy.mockRestore()

      // A default call now reads the refreshed memo without spawning
      const { calls } = mockAsync({ whoami: WHOAMI_LOGGED_IN })
      const afterwards = await verifyAuthAsync()

      expect(calls.length).toBe(0)
      expect(afterwards).toEqual(fresh)
      expect(afterwards.authenticated).toBe(false)
    })

    test("fresh: true overwrites the memo the sync verifyAuth() reads too", async () => {
      mockHome()
      const warm = mockAsync({ whoami: WHOAMI_LOGGED_IN })
      await verifyAuthAsync()
      warm.spy.mockRestore()

      const refreshed = mockAsync({ whoami: WHOAMI_LOGGED_OUT })
      const fresh = await verifyAuthAsync({ fresh: true })
      refreshed.spy.mockRestore()

      const syncSpy = mockKiroCli({ whoami: WHOAMI_LOGGED_IN }) // would flip the result if spawned
      spies.push(syncSpy)
      const syncStatus = verifyAuth()

      expect(syncSpy).toHaveBeenCalledTimes(0)
      expect(syncStatus).toEqual(fresh)
      expect(syncStatus.authenticated).toBe(false)
    })

    test("fresh: true joins a probe already in flight instead of spawning a second", async () => {
      mockHome()
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      const { calls } = mockAsync({ whoami: WHOAMI_LOGGED_IN, gate })

      // A default probe is in flight; a fresh caller arrives before it answers
      const inFlight = verifyAuthAsync()
      const fresh = verifyAuthAsync({ fresh: true })
      release()
      const [a, b] = await Promise.all([inFlight, fresh])

      expect(calls.length).toBe(2) // exactly one version+whoami pair
      expect(a).toEqual(b)
      expect(a.authenticated).toBe(true)
    })

    test("two fresh callers in flight coalesce onto one probe", async () => {
      mockHome()
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      const { calls } = mockAsync({ whoami: WHOAMI_LOGGED_OUT, gate })

      const first = verifyAuthAsync({ fresh: true })
      const second = verifyAuthAsync({ fresh: true })
      release()
      const [a, b] = await Promise.all([first, second])

      expect(calls.length).toBe(2)
      expect(a).toEqual(b)
      expect(a.authenticated).toBe(false)
    })

    test("fresh: true on a cold memo probes once, like the default", async () => {
      mockHome()
      const { calls } = mockAsync({ whoami: WHOAMI_LOGGED_IN })

      const status = await verifyAuthAsync({ fresh: true })

      expect(calls.length).toBe(2)
      expect(status.authenticated).toBe(true)
    })

    test("fresh: true never rejects when both spawns fail", async () => {
      mockHome()
      mockAsync({ version: new Error("boom"), whoami: new Error("kaboom") })

      await expect(verifyAuthAsync({ fresh: true })).resolves.toEqual({ installed: false, authenticated: false })
    })
  })

  // --- inconclusive: whoami never answered (async twin of the sync cases) ------

  describe("inconclusive marker (async)", () => {
    test("whoami timeout (SIGTERM kill) => authenticated false, inconclusive true", async () => {
      mockHome()
      const err = Object.assign(new Error("Command timed out"), { killed: true, signal: "SIGTERM", code: null })
      mockAsync({ whoami: err })

      const status = await verifyAuthAsync()

      expect(status.installed).toBe(true)
      expect(status.authenticated).toBe(false)
      expect(status.inconclusive).toBe(true)
    })

    test("whoami spawn error (string code, no exit status) => inconclusive true", async () => {
      mockHome()
      const err = Object.assign(new Error("spawn kiro-cli ENOENT"), { code: "ENOENT", syscall: "spawn kiro-cli" })
      mockAsync({ whoami: err })

      const status = await verifyAuthAsync()

      expect(status.installed).toBe(true)
      expect(status.authenticated).toBe(false)
      expect(status.inconclusive).toBe(true)
    })

    test("whoami non-zero exit with logged-out output => definitive, no inconclusive key", async () => {
      // execFile reports a non-zero exit with a numeric code; kiro-cli answered
      mockHome()
      const err = Object.assign(new Error("exit 1"), { code: 1 })
      mockAsync({ whoami: { error: err, stdout: WHOAMI_LOGGED_OUT } })

      const status = await verifyAuthAsync()

      expect(status.installed).toBe(true)
      expect(status.authenticated).toBe(false)
      expect("inconclusive" in status).toBe(false)
    })

    test("whoami non-zero exit with logged-in output => authenticated, no inconclusive key", async () => {
      mockHome()
      const err = Object.assign(new Error("exit 1"), { code: 1 })
      mockAsync({ whoami: { error: err, stderr: WHOAMI_LOGGED_IN } })

      const status = await verifyAuthAsync()

      expect(status.authenticated).toBe(true)
      expect("inconclusive" in status).toBe(false)
    })

    test("definitive JSON answers carry no inconclusive key", async () => {
      mockHome()
      const loggedOut = mockAsync({ whoami: WHOAMI_LOGGED_OUT })
      expect("inconclusive" in (await verifyAuthAsync())).toBe(false)
      loggedOut.spy.mockRestore()

      resetAuthCache()
      mockAsync({ whoami: WHOAMI_LOGGED_IN })
      expect("inconclusive" in (await verifyAuthAsync())).toBe(false)
    })

    test("version timeout => installed true and whoami decides, including its inconclusive verdict", async () => {
      mockHome()
      const timeout = Object.assign(new Error("Command timed out"), { killed: true, signal: "SIGTERM", code: null })
      const answered = mockAsync({ version: timeout, whoami: WHOAMI_LOGGED_OUT })
      const definitive = await verifyAuthAsync()
      expect(definitive.installed).toBe(true)
      expect(definitive.authenticated).toBe(false)
      expect(definitive.version).toBeUndefined()
      expect("inconclusive" in definitive).toBe(false)
      answered.spy.mockRestore()

      resetAuthCache()
      mockAsync({ version: timeout, whoami: timeout })
      const undecided = await verifyAuthAsync()
      expect(undecided.installed).toBe(true)
      expect(undecided.inconclusive).toBe(true)
    })

    test("any other version failure => installed false and never inconclusive", async () => {
      mockHome()
      const err = Object.assign(new Error("spawn kiro-cli ENOENT"), { code: "ENOENT" })
      const { calls } = mockAsync({ version: err, whoami: WHOAMI_LOGGED_IN })

      const status = await verifyAuthAsync()

      expect(status).toEqual({ installed: false, authenticated: false })
      expect(calls.filter((c) => c.args.includes("whoami")).length).toBe(0)
    })

    test("sync and async paths agree on the inconclusive verdict", async () => {
      // Arrange: the same whoami timeout on both spawn mechanics
      mockHome()
      const syncTimeout = Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT", signal: "SIGTERM" })
      const asyncTimeout = Object.assign(new Error("Command timed out"), { killed: true, signal: "SIGTERM", code: null })

      spies.push(mockKiroCli({ whoami: syncTimeout }))
      const syncStatus = verifyAuth()
      resetAuthCache()
      mockAsync({ whoami: asyncTimeout })
      const asyncStatus = await verifyAuthAsync({ fresh: true })

      // Assert
      expect(syncStatus.inconclusive).toBe(true)
      expect(asyncStatus.inconclusive).toBe(true)
      expect(asyncStatus).toEqual(syncStatus)
    })

    test("a fresh probe reports inconclusive the same way as the default", async () => {
      mockHome()
      const err = Object.assign(new Error("spawn kiro-cli EACCES"), { code: "EACCES" })
      mockAsync({ whoami: err })

      const status = await verifyAuthAsync({ fresh: true })

      expect(status).toMatchObject({ installed: true, authenticated: false, inconclusive: true })
    })
  })

  // --- spawn options: win32 shell resolution + verbatim timeouts -------------

  test("async spawns use shell:true when process.platform is win32", async () => {
    mockHome()
    const { calls } = mockAsync({ whoami: WHOAMI_LOGGED_IN })
    const original = Object.getOwnPropertyDescriptor(process, "platform")!
    Object.defineProperty(process, "platform", { value: "win32" })
    try {
      await verifyAuthAsync()
    } finally {
      Object.defineProperty(process, "platform", original) // restore even on failure
    }

    expect(calls.length).toBe(2)
    for (const call of calls) {
      expect(call.file).toBe("kiro-cli")
      expect(call.options?.shell).toBe(true)
    }
  })

  test("async spawns branch shell on the real process.platform", async () => {
    // Do not assume a non-win32 CI: assert against the actual platform.
    mockHome()
    const { calls } = mockAsync({ whoami: WHOAMI_LOGGED_IN })

    await verifyAuthAsync()

    const expectedShell = process.platform === "win32"
    expect(calls.length).toBe(2)
    for (const call of calls) expect(call.options?.shell).toBe(expectedShell)
  })

  test("async spawns carry the verbatim 10s timeouts", async () => {
    mockHome()
    const { calls } = mockAsync({ whoami: WHOAMI_LOGGED_IN })

    await verifyAuthAsync()

    const version = calls.find((c) => c.args.includes("--version"))
    const whoami = calls.find((c) => c.args.includes("whoami"))
    expect(version?.options?.timeout).toBe(10000)
    expect(whoami?.options?.timeout).toBe(10000)
  })
})
