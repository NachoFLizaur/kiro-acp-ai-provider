import { describe, test, expect, afterEach } from "bun:test"
import { readStallHint, pickHint, kiroChatLogPath, STALL_HINT_MAX_CHARS } from "../src/kiro-log-hint"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// ---------------------------------------------------------------------------
// kiro-cli chat log hint reader
//
// Contract: `readStallHint(since, path)` resolves the newest ERROR line whose
// leading timestamp is at or after `since`, with ANSI colour codes removed
// and the text cut to STALL_HINT_MAX_CHARS. Any failure (missing file,
// unreadable file, no qualifying line) resolves `undefined`; the promise
// never rejects. Only the tail of the file is read, so the size of the log
// never affects the cost of a call.
// ---------------------------------------------------------------------------

const RED = "\x1b[31m"
const BOLD = "\x1b[1m"
const RESET = "\x1b[0m"

/** ISO timestamp with microseconds, as kiro-cli's tracing layer writes it. */
function stamp(epochMs: number): string {
  return new Date(epochMs).toISOString().replace("Z", "123Z")
}

/** Colour a log line the way kiro-cli does (level in colour, rest plain). */
function coloured(epochMs: number, level: string, message: string): string {
  return `${stamp(epochMs)} ${BOLD}${RED}${level}${RESET} ${message}`
}

describe("readStallHint", () => {
  const tempDirs: string[] = []

  function makeLogPath(content?: string): string {
    const dir = mkdtempSync(join(tmpdir(), "kiro-log-hint-test-"))
    tempDirs.push(dir)
    const path = join(dir, "kiro-chat.log")
    if (content !== undefined) writeFileSync(path, content)
    return path
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    }
    tempDirs.length = 0
  })

  test("returns the newest ERROR line newer than the prompt start, stripped of colour codes", async () => {
    // Arrange
    const since = Date.UTC(2026, 8, 3, 18, 21, 0)
    const lines = [
      coloured(since - 60_000, "ERROR", "chat_cli_v2::agent::rts: old failure before the prompt"),
      coloured(since + 1_000, "ERROR", "chat_cli_v2::agent::rts: first failure err=ModelOverloadedError"),
      coloured(since + 2_000, "WARN", "chat_cli_v2::agent::rts: retrying"),
      coloured(since + 3_000, "ERROR", "chat_cli_v2::agent::rts: second failure err=ModelOverloadedError"),
      coloured(since + 4_000, "INFO", "not an error line"),
    ]
    const path = makeLogPath(lines.join("\n") + "\n")

    // Act
    const hint = await readStallHint(since, path)

    // Assert
    expect(hint).toBe(
      `${stamp(since + 3_000)} ERROR chat_cli_v2::agent::rts: second failure err=ModelOverloadedError`,
    )
    expect(hint).not.toContain("\x1b")
  })

  test("ignores ERROR lines written before the prompt started", async () => {
    // Arrange
    const since = Date.UTC(2026, 8, 3, 18, 21, 0)
    const path = makeLogPath(
      [
        coloured(since - 5_000, "ERROR", "stale failure"),
        coloured(since - 1, "ERROR", "one millisecond too early"),
      ].join("\n") + "\n",
    )

    // Act
    const hint = await readStallHint(since, path)

    // Assert
    expect(hint).toBeUndefined()
  })

  test("accepts a line stamped exactly at the prompt start", async () => {
    // Arrange
    const since = Date.UTC(2026, 8, 3, 18, 21, 0)
    const path = makeLogPath(coloured(since, "ERROR", "boundary failure") + "\n")

    // Act
    const hint = await readStallHint(since, path)

    // Assert
    expect(hint).toContain("boundary failure")
  })

  test("truncates long lines to the maximum hint length with a marker", async () => {
    // Arrange
    const since = Date.UTC(2026, 8, 3, 18, 21, 0)
    const longMessage = "x".repeat(2_000)
    const path = makeLogPath(coloured(since + 500, "ERROR", longMessage) + "\n")

    // Act
    const hint = await readStallHint(since, path)

    // Assert
    expect(hint).toBeDefined()
    expect(hint!.length).toBe(STALL_HINT_MAX_CHARS)
    expect(hint!.endsWith("...")).toBe(true)
    expect(hint!.startsWith(stamp(since + 500))).toBe(true)
  })

  test("resolves undefined when the log file does not exist", async () => {
    // Arrange
    const missing = join(makeLogPath(), "does-not-exist", "kiro-chat.log")

    // Act
    const hint = await readStallHint(0, missing)

    // Assert
    expect(hint).toBeUndefined()
  })

  test("resolves undefined for an empty log", async () => {
    // Arrange
    const path = makeLogPath("")

    // Act
    const hint = await readStallHint(0, path)

    // Assert
    expect(hint).toBeUndefined()
  })

  test("resolves undefined when the log holds no ERROR lines", async () => {
    // Arrange
    const since = Date.UTC(2026, 8, 3, 18, 21, 0)
    const path = makeLogPath(
      [coloured(since + 1_000, "WARN", "slow"), coloured(since + 2_000, "INFO", "fine")].join("\n") + "\n",
    )

    // Act
    const hint = await readStallHint(since, path)

    // Assert
    expect(hint).toBeUndefined()
  })

  test("resolves undefined instead of rejecting when the file cannot be read", async () => {
    // Arrange: a directory where the file is expected makes open() fail
    const dir = mkdtempSync(join(tmpdir(), "kiro-log-hint-test-"))
    tempDirs.push(dir)
    const path = join(dir, "kiro-chat.log")
    mkdirSync(path)
    // Also cover a permission failure where the platform honours mode bits
    const unreadable = join(dir, "unreadable.log")
    writeFileSync(unreadable, "2026-09-03T18:21:04.508113Z ERROR secret\n")
    chmodSync(unreadable, 0o000)

    // Act
    const fromDirectory = readStallHint(0, path)
    const fromUnreadable = readStallHint(0, unreadable)

    // Assert
    await expect(fromDirectory).resolves.toBeUndefined()
    // Running as root would make the file readable regardless; either result
    // is acceptable there, but the promise must settle without rejecting.
    const value = await fromUnreadable
    expect(value === undefined || typeof value === "string").toBe(true)
    chmodSync(unreadable, 0o600)
  })

  test("finds a qualifying line near the end of a log much larger than the tail read", async () => {
    // Arrange: ~1 MiB of old, pre-prompt error lines followed by one fresh one.
    const since = Date.UTC(2026, 8, 3, 18, 21, 0)
    const filler = coloured(since - 3_600_000, "ERROR", "old " + "y".repeat(400))
    const oldLines = Array.from({ length: 2_500 }, () => filler)
    const fresh = coloured(since + 250, "ERROR", "chat_cli_v2::agent::rts: fresh failure err=ModelOverloadedError")
    const path = makeLogPath([...oldLines, fresh].join("\n") + "\n")

    // Act
    const started = Date.now()
    const hint = await readStallHint(since, path)
    const elapsed = Date.now() - started

    // Assert
    expect(hint).toContain("fresh failure")
    // A tail read of a fixed size must not scale with the file; a full read
    // and scan of 1 MiB would still be quick, so the bound is only a sanity check.
    expect(elapsed).toBeLessThan(2_000)
  })

  test("ignores a qualifying line that sits entirely outside the tail window", async () => {
    // Arrange: the only fresh line is buried under far more than the tail
    // size of old lines, so a bounded reader must never see it.
    const since = Date.UTC(2026, 8, 3, 18, 21, 0)
    const fresh = coloured(since + 250, "ERROR", "buried fresh failure")
    const filler = coloured(since - 3_600_000, "ERROR", "old " + "y".repeat(400))
    const oldLines = Array.from({ length: 2_500 }, () => filler)
    const path = makeLogPath([fresh, ...oldLines].join("\n") + "\n")

    // Act
    const hint = await readStallHint(since, path)

    // Assert
    expect(hint).toBeUndefined()
  })

  test("defaults to the kiro-cli chat log under the system temp directory", () => {
    expect(kiroChatLogPath()).toBe(join(tmpdir(), "kiro-log", "kiro-chat.log"))
  })
})

describe("pickHint", () => {
  const since = Date.UTC(2026, 8, 3, 18, 21, 0)

  test("skips the first line of a mid-file read because it may be a fragment", () => {
    // Arrange: the first line looks like a complete, qualifying ERROR line,
    // but a read that did not start at byte 0 cannot trust it.
    const text = [
      coloured(since + 9_000, "ERROR", "possibly cut off at the front"),
      coloured(since - 1_000, "INFO", "nothing"),
    ].join("\n")

    // Act / Assert
    expect(pickHint(text, true, since)).toBeUndefined()
    expect(pickHint(text, false, since)).toContain("possibly cut off")
  })

  test("skips lines whose timestamp is missing or malformed", () => {
    const text = [
      "ERROR no timestamp at all",
      "2026-13-45T99:99:99Z ERROR impossible date",
      coloured(since + 1, "ERROR", "the good one"),
      "garbage ERROR trailing",
    ].join("\n")

    expect(pickHint(text, false, since)).toContain("the good one")
  })

  test("collapses internal whitespace and handles CRLF line endings", () => {
    const text = `${stamp(since + 1)} ERROR   spaced\t\tout   message\r\n`

    expect(pickHint(text, false, since)).toBe(`${stamp(since + 1)} ERROR spaced out message`)
  })

  test("requires ERROR as a whole word surrounded by spaces", () => {
    const text = [
      `${stamp(since + 1)} WARN failed with ERRORS`,
      `${stamp(since + 2)} INFO ERRORED but not an error level`,
    ].join("\n")

    expect(pickHint(text, false, since)).toBeUndefined()
  })

  test("returns undefined for empty input", () => {
    expect(pickHint("", false, since)).toBeUndefined()
  })
})
