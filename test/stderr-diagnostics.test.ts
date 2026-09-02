import { describe, test, expect } from "bun:test"
import { ACPClient, KiroACPError, KiroACPConnectionError } from "../src/acp-client"

// ---------------------------------------------------------------------------
// Stderr diagnostics
//
// formatRecentStderr() and createTimeoutError() are private methods.
// They are exercised directly by casting the client to `any`.
// ---------------------------------------------------------------------------

describe("stderr diagnostics", () => {
  /** Helper to access private methods on ACPClient. */
  function getPrivate(client: ACPClient) {
    return client as any
  }

  test("timeout error for initialize includes stderr when present", () => {
    // Arrange
    const client = new ACPClient({ cwd: "/tmp" })
    const priv = getPrivate(client)
    priv.stderrBuffer = "Error: ENOENT kiro-cli not found"

    // Act
    const error = priv.createTimeoutError("initialize", 30000) as KiroACPError

    // Assert
    expect(error).toBeInstanceOf(KiroACPError)
    expect(error.message).toContain("Request timed out after 30000ms: initialize")
    expect(error.message).toContain("kiro-cli stderr:")
    expect(error.message).toContain("ENOENT kiro-cli not found")
  })

  test("timeout error for session/new includes stderr", () => {
    // Arrange
    const client = new ACPClient({ cwd: "/tmp" })
    const priv = getPrivate(client)
    priv.stderrBuffer = "Authentication expired"

    // Act
    const error = priv.createTimeoutError("session/new", 30000) as KiroACPError

    // Assert
    expect(error).toBeInstanceOf(KiroACPError)
    expect(error.message).toContain("Request timed out after 30000ms: session/new")
    expect(error.message).toContain("kiro-cli stderr:")
    expect(error.message).toContain("Authentication expired")
  })

  test("timeout error for session/prompt excludes stderr", () => {
    // Arrange
    const client = new ACPClient({ cwd: "/tmp" })
    const priv = getPrivate(client)
    priv.stderrBuffer = "Some stderr output"

    // Act
    const error = priv.createTimeoutError("session/prompt", 300000) as KiroACPError

    // Assert
    expect(error).toBeInstanceOf(KiroACPError)
    expect(error.message).toBe("Request timed out after 300000ms: session/prompt")
    expect(error.message).not.toContain("kiro-cli stderr:")
    expect(error.message).not.toContain("Some stderr output")
  })

  test("timeout error without stderr has clean message", () => {
    // Arrange
    const client = new ACPClient({ cwd: "/tmp" })
    const priv = getPrivate(client)
    priv.stderrBuffer = ""

    // Act
    const error = priv.createTimeoutError("initialize", 30000) as KiroACPError

    // Assert
    expect(error).toBeInstanceOf(KiroACPError)
    expect(error.message).toBe("Request timed out after 30000ms: initialize")
    expect(error.message).not.toContain("kiro-cli stderr:")
  })

  // NOTE: The exit/error handlers in ACPClient (handleProcessExit, handleProcessError)
  // also include stderr for connection-phase methods (initialize, session/new).
  // These handlers are difficult to unit test because they require a real spawned
  // child process to emit 'exit' or 'error' events. The timeout path tested above
  // exercises the same formatRecentStderr() + method-gating logic, providing
  // equivalent coverage of the stderr-inclusion decision.

  test("-32603 JSON-RPC response appends recent kiro-cli stderr to the error", () => {
    // -32603 is the generic JSON-RPC "Internal error"; the real cause lives in
    // kiro-cli's stderr, which must now be surfaced on the response path too.
    const client = new ACPClient({ cwd: "/tmp" })
    const priv = getPrivate(client)
    priv.stderrBuffer = "error: backend rejected request (quota exceeded)"

    let rejected: unknown
    priv.pending.set(7, {
      resolve: () => {},
      reject: (e: Error) => { rejected = e },
      method: "session/prompt",
      timer: null,
    })

    priv.handleResponse({ jsonrpc: "2.0", id: 7, error: { code: -32603, message: "Internal error" } })

    expect(rejected).toBeInstanceOf(KiroACPError)
    const error = rejected as KiroACPError
    expect(error.code).toBe(-32603)
    expect(error.message).toContain("Internal error")
    expect(error.message).toContain("kiro-cli stderr:")
    expect(error.message).toContain("quota exceeded")
  })

  test("-32603 response with empty stderr buffer leaves the message clean", () => {
    const client = new ACPClient({ cwd: "/tmp" })
    const priv = getPrivate(client)
    priv.stderrBuffer = ""

    let rejected: unknown
    priv.pending.set(8, {
      resolve: () => {},
      reject: (e: Error) => { rejected = e },
      method: "session/prompt",
      timer: null,
    })

    priv.handleResponse({ jsonrpc: "2.0", id: 8, error: { code: -32603, message: "Internal error" } })

    expect(rejected).toBeInstanceOf(KiroACPError)
    expect((rejected as KiroACPError).message).toBe("Internal error")
    expect((rejected as KiroACPError).message).not.toContain("kiro-cli stderr:")
  })

  test("non -32603 JSON-RPC response does NOT append stderr", () => {
    const client = new ACPClient({ cwd: "/tmp" })
    const priv = getPrivate(client)
    priv.stderrBuffer = "error: unrelated noise"

    let rejected: unknown
    priv.pending.set(9, {
      resolve: () => {},
      reject: (e: Error) => { rejected = e },
      method: "session/prompt",
      timer: null,
    })

    priv.handleResponse({ jsonrpc: "2.0", id: 9, error: { code: -32000, message: "Some other error" } })

    expect(rejected).toBeInstanceOf(KiroACPError)
    expect((rejected as KiroACPError).message).toBe("Some other error")
    expect((rejected as KiroACPError).message).not.toContain("kiro-cli stderr:")
  })

  test("stderrBuffer is reset on start", async () => {
    // Arrange: use a non-existent absolute path so start() fails early
    // (after resetting the buffer but before spawning kiro-cli)
    const client = new ACPClient({ cwd: "/tmp/nonexistent-dir-for-test-12345" })
    const priv = getPrivate(client)

    // Simulate some stderr from a previous run
    priv.stderrBuffer = "old stderr data from previous run"
    expect(priv.stderrBuffer).toBe("old stderr data from previous run")

    // Act: start() resets the buffer at the very top, then throws on cwd validation
    try {
      await client.start()
    } catch {
      // Expected: "cwd is not a directory" error
    }

    // Assert: buffer was reset at the beginning of start()
    expect(priv.stderrBuffer).toBe("")
  })
})
