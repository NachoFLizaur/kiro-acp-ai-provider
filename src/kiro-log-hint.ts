import { open } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// kiro-cli chat log hint reader
// ---------------------------------------------------------------------------
//
// kiro-cli writes its own diagnostics to `<tmpdir>/kiro-log/kiro-chat.log`
// (ERROR level only by default, ANSI-coloured). When a turn stalls, the most
// recent ERROR line written since the prompt started is the best available
// explanation - for example a `ModelOverloadedError` from the model backend
// that kiro-cli is silently retrying.
//
// Invariants of this module:
// - Read-only and best-effort. Every failure (missing file, permission error,
//   short read, malformed lines) resolves to `undefined`; the returned promise
//   never rejects and the function never throws synchronously.
// - Bounded work per call. Only the last `LOG_TAIL_BYTES` of the file are read,
//   regardless of file size. No watchers, polling, or timers are created.
// - No environment mutation. In particular kiro-cli's stdout logging switch is
//   never touched, so the log keeps flowing to the file this module reads.

/** Maximum length of a returned hint, including the truncation marker. */
export const STALL_HINT_MAX_CHARS = 160

/**
 * Bytes read from the end of the log per call. A single ERROR line with a
 * serialized request error is typically 500-1500 bytes; 64 KiB covers dozens
 * of such lines (a whole retry burst) while staying a trivial single read.
 */
const LOG_TAIL_BYTES = 64 * 1024

const TRUNCATION_MARKER = "..."

/**
 * ANSI escape sequences: CSI (`ESC [ ... final`), OSC (`ESC ] ... BEL|ST`) and
 * single-character `ESC x` controls.
 */
const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g

/** Leading ISO-8601 UTC timestamp as written by kiro-cli's tracing layer. */
const TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z/

/** Absolute path of the kiro-cli chat log for the current user. */
export function kiroChatLogPath(): string {
  return join(tmpdir(), "kiro-log", "kiro-chat.log")
}

/**
 * Return the newest ERROR line in the kiro-cli chat log whose timestamp is at
 * or after `sinceEpochMs`, ANSI-stripped, collapsed to one line and truncated
 * to `STALL_HINT_MAX_CHARS`. Resolves `undefined` when no such line exists or
 * the log cannot be read. Never rejects.
 *
 * @param sinceEpochMs Lower bound (inclusive) for the line timestamp, usually
 *   the wall-clock time the current prompt was sent.
 * @param logPath Log file to read. Defaults to `kiroChatLogPath()`.
 */
export async function readStallHint(
  sinceEpochMs: number,
  logPath: string = kiroChatLogPath(),
): Promise<string | undefined> {
  try {
    const tail = await readTail(logPath, LOG_TAIL_BYTES)
    if (tail === undefined) return undefined
    return pickHint(tail.text, tail.truncatedHead, sinceEpochMs)
  } catch {
    return undefined
  }
}

/**
 * Read at most `maxBytes` from the end of `path`. `truncatedHead` is true when
 * the read did not start at byte 0, in which case the first line of `text` is
 * most likely a fragment.
 */
async function readTail(
  path: string,
  maxBytes: number,
): Promise<{ text: string; truncatedHead: boolean } | undefined> {
  const handle = await open(path, "r")
  try {
    const { size } = await handle.stat()
    if (size <= 0) return undefined
    const length = Math.min(size, maxBytes)
    const position = size - length
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    return {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      truncatedHead: position > 0,
    }
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * Scan `text` from the last line backwards for the newest ERROR line at or
 * after `sinceEpochMs`. Pure: no I/O, never throws for any string input.
 */
export function pickHint(
  text: string,
  truncatedHead: boolean,
  sinceEpochMs: number,
): string | undefined {
  const lines = text.split(/\r?\n/)
  // The first line of a mid-file read is a fragment; never trust it.
  const firstIndex = truncatedHead ? 1 : 0

  for (let i = lines.length - 1; i >= firstIndex; i--) {
    const line = lines[i].replace(ANSI_PATTERN, "")
    if (!line.includes(" ERROR ")) continue

    const timestamp = parseLeadingTimestamp(line)
    if (timestamp === undefined || timestamp < sinceEpochMs) continue

    return truncate(line.replace(/\s+/g, " ").trim(), STALL_HINT_MAX_CHARS)
  }

  return undefined
}

/** Epoch ms of the line's leading timestamp, or undefined when absent/invalid. */
function parseLeadingTimestamp(line: string): number | undefined {
  const match = TIMESTAMP_PATTERN.exec(line)
  if (!match) return undefined
  // Date.parse accepts at most millisecond precision portably; kiro-cli logs
  // microseconds, so the fraction is cut to three digits before parsing.
  const fraction = (match[2] ?? "").slice(0, 3).padEnd(3, "0")
  const parsed = Date.parse(`${match[1]}.${fraction}Z`)
  return Number.isNaN(parsed) ? undefined : parsed
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return value.slice(0, maxChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
}
