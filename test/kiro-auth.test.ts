import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { isTokenValid, verifyAuth, type AuthStatus } from "../src/kiro-auth"

// ---------------------------------------------------------------------------
// verifyAuth() expiry gate (task 14 / SDK 2.0.1).
//
// kiro-cli `whoami` reports "Logged in" off mere token PRESENCE, so an expired
// cached token still looks authenticated. `isTokenValid` is the expiry gate
// verifyAuth() delegates to: it must reject expired, missing, and unparseable
// `expiresAt` values while accepting a future timestamp. These tests exercise
// the gate against real token-file fixtures in a temp dir (no kiro-cli spawn,
// no backend) per the repo's filesystem-fixture convention.
// ---------------------------------------------------------------------------

describe("isTokenValid", () => {
  let testDir: string

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kiro-auth-test-"))
  })

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  /** Write a token fixture and return its path. */
  function writeToken(contents: unknown): string {
    const tokenPath = join(testDir, "kiro-auth-token.json")
    const raw = typeof contents === "string" ? contents : JSON.stringify(contents)
    writeFileSync(tokenPath, raw)
    return tokenPath
  }

  test("valid token (expiresAt in the future) is valid", () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    expect(isTokenValid(writeToken({ expiresAt: future }))).toBe(true)
  })

  test("expired token (expiresAt in the past) is NOT valid", () => {
    // The real-world expired value that triggered the -32603 failures.
    expect(isTokenValid(writeToken({ expiresAt: "2025-04-01T00:00:00.000Z" }))).toBe(false)
  })

  test("expiresAt exactly now is NOT valid (strict future required)", () => {
    const now = new Date(Date.now()).toISOString()
    // The fixture timestamp is <= Date.now() by the time we evaluate it.
    expect(isTokenValid(writeToken({ expiresAt: now }))).toBe(false)
  })

  test("missing expiresAt field is NOT valid", () => {
    expect(isTokenValid(writeToken({ accessToken: "abc" }))).toBe(false)
  })

  test("non-string (garbage) expiresAt is NOT valid", () => {
    expect(isTokenValid(writeToken({ expiresAt: 12345 }))).toBe(false)
  })

  test("unparseable expiresAt string is NOT valid", () => {
    expect(isTokenValid(writeToken({ expiresAt: "not-a-date" }))).toBe(false)
  })

  test("malformed JSON is NOT valid and does not throw", () => {
    expect(isTokenValid(writeToken("this is not valid json {{{"))).toBe(false)
  })

  test("missing token file is NOT valid and does not throw", () => {
    expect(isTokenValid(join(testDir, "does-not-exist.json"))).toBe(false)
  })
})

describe("verifyAuth", () => {
  test("never throws and returns an AuthStatus value", () => {
    let status: AuthStatus | undefined
    expect(() => {
      status = verifyAuth()
    }).not.toThrow()
    expect(status).toBeDefined()
    expect(typeof status!.installed).toBe("boolean")
    expect(typeof status!.authenticated).toBe("boolean")
  })
})
