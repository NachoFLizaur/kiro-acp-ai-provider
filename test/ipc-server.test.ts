import { describe, test, expect, afterEach } from "bun:test"
import {
  createIPCServer,
  type IPCServer,
  type ToolExecuteResponse,
  type PendingToolCall,
  type ToolCallHandler,
} from "../src/ipc-server"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make an HTTP request to the IPC server and return parsed JSON. */
async function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const url = `http://127.0.0.1:${port}${path}`
  const options: RequestInit = {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }

  const response = await fetch(url, options)
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = text
  }
  return { status: response.status, body: parsed }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IPCServer", () => {
  let server: IPCServer
  let port: number

  afterEach(async () => {
    if (server) {
      await server.stop()
    }
  })

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  describe("start()", () => {
    test("starts on a random port and returns the port number", async () => {
      server = createIPCServer()
      port = await server.start()

      expect(port).toBeGreaterThan(0)
      expect(port).toBeLessThan(65536)
      expect(server.getPort()).toBe(port)
    })

    test("throws if started twice", async () => {
      server = createIPCServer()
      await server.start()

      expect(server.start()).rejects.toThrow("already running")
    })
  })

  describe("stop()", () => {
    test("cleans up and resets port to null", async () => {
      server = createIPCServer()
      port = await server.start()

      expect(server.getPort()).toBe(port)

      await server.stop()

      expect(server.getPort()).toBeNull()
    })

    test("is safe to call when not started", async () => {
      server = createIPCServer()
      // Should not throw
      await server.stop()
    })

    test("resolves pending calls with error on stop", async () => {
      server = createIPCServer()
      port = await server.start()

      // Register a handler so the call gets stored
      server.setToolCallHandler(() => {
        // Don't resolve — let it stay pending
      })

      // Start a pending tool call (don't await it)
      const callPromise = httpRequest(port, "POST", "/tool/pending", {
        callId: "call-1",
        toolName: "bash",
        args: { command: "ls" },
      })

      // Give the request time to reach the server
      await new Promise((r) => setTimeout(r, 50))

      expect(server.getPendingCount()).toBe(1)

      // Stop the server — should resolve the pending call with error
      await server.stop()

      expect(server.getPendingCount()).toBe(0)

      // The HTTP request should complete (with an error response or connection error)
      try {
        const result = await callPromise
        const body = result.body as ToolExecuteResponse
        expect(body.status).toBe("error")
      } catch {
        // Connection error is also acceptable — server closed
      }
    })
  })

  // -------------------------------------------------------------------------
  // GET /health
  // -------------------------------------------------------------------------

  describe("GET /health", () => {
    test("returns status ok with uptime and pending count", async () => {
      server = createIPCServer()
      port = await server.start()

      const { status, body } = await httpRequest(port, "GET", "/health")

      expect(status).toBe(200)
      const health = body as { status: string; uptime: number; pendingCalls: number }
      expect(health.status).toBe("ok")
      expect(health.uptime).toBeGreaterThanOrEqual(0)
      expect(health.pendingCalls).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // POST /tool/pending + POST /tool/result — Hold-and-wait pattern
  // -------------------------------------------------------------------------

  describe("POST /tool/pending + /tool/result", () => {
    test("holds response until result is sent via /tool/result", async () => {
      server = createIPCServer()
      port = await server.start()

      // Register handler to capture the tool call
      let receivedCall: PendingToolCall | null = null
      server.setToolCallHandler((call) => {
        receivedCall = call
      })

      // Start a pending call (don't await — it blocks)
      const pendingPromise = httpRequest(port, "POST", "/tool/pending", {
        callId: "call-1",
        toolName: "bash",
        args: { command: "echo hello" },
      })

      // Wait for the call to be registered
      await new Promise((r) => setTimeout(r, 50))

      expect(server.getPendingCount()).toBe(1)
      expect(receivedCall).not.toBeNull()
      expect(receivedCall!.callId).toBe("call-1")
      expect(receivedCall!.toolName).toBe("bash")
      expect(receivedCall!.args).toEqual({ command: "echo hello" })

      // Send the result
      const resultResponse = await httpRequest(port, "POST", "/tool/result", {
        callId: "call-1",
        result: "hello\n",
        isError: false,
      })

      expect(resultResponse.status).toBe(200)
      expect((resultResponse.body as { status: string }).status).toBe("ok")

      // The pending call should now resolve
      const pendingResult = await pendingPromise
      expect(pendingResult.status).toBe(200)
      const body = pendingResult.body as ToolExecuteResponse
      expect(body.status).toBe("success")
      expect(body.result).toBe("hello\n")

      expect(server.getPendingCount()).toBe(0)
    })

    test("returns error result when isError is true", async () => {
      server = createIPCServer()
      port = await server.start()

      server.setToolCallHandler(() => {})

      const pendingPromise = httpRequest(port, "POST", "/tool/pending", {
        callId: "call-err",
        toolName: "bash",
        args: { command: "false" },
      })

      await new Promise((r) => setTimeout(r, 50))

      await httpRequest(port, "POST", "/tool/result", {
        callId: "call-err",
        result: "Command failed with exit code 1",
        isError: true,
      })

      const pendingResult = await pendingPromise
      const body = pendingResult.body as ToolExecuteResponse
      expect(body.status).toBe("error")
      expect(body.error).toBe("Command failed with exit code 1")
    })

    test("returns 404 for /tool/result with unknown callId", async () => {
      server = createIPCServer()
      port = await server.start()

      const { status, body } = await httpRequest(port, "POST", "/tool/result", {
        callId: "nonexistent",
        result: "some result",
      })

      expect(status).toBe(404)
      expect((body as { code: string }).code).toBe("NOT_FOUND")
    })

    test("returns INVALID_REQUEST for malformed JSON on /tool/pending", async () => {
      server = createIPCServer()
      port = await server.start()

      const response = await fetch(`http://127.0.0.1:${port}/tool/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json{{{",
      })

      expect(response.status).toBe(400)
      const result = (await response.json()) as ToolExecuteResponse
      expect(result.code).toBe("INVALID_REQUEST")
    })

    test("returns INVALID_REQUEST for missing required fields on /tool/pending", async () => {
      server = createIPCServer()
      port = await server.start()

      const { status, body } = await httpRequest(port, "POST", "/tool/pending", {
        args: {},
      })

      expect(status).toBe(400)
      expect((body as { code: string }).code).toBe("INVALID_REQUEST")
    })

    test("handles concurrent pending calls", async () => {
      server = createIPCServer()
      port = await server.start()

      const receivedCalls: PendingToolCall[] = []
      server.setToolCallHandler((call) => {
        receivedCalls.push(call)
      })

      // Start 3 concurrent pending calls
      const promises = [
        httpRequest(port, "POST", "/tool/pending", {
          callId: "call-a",
          toolName: "bash",
          args: { command: "echo a" },
        }),
        httpRequest(port, "POST", "/tool/pending", {
          callId: "call-b",
          toolName: "read_file",
          args: { filePath: "/tmp/test" },
        }),
        httpRequest(port, "POST", "/tool/pending", {
          callId: "call-c",
          toolName: "glob",
          args: { pattern: "*.ts" },
        }),
      ]

      await new Promise((r) => setTimeout(r, 50))
      expect(server.getPendingCount()).toBe(3)
      expect(receivedCalls).toHaveLength(3)

      // Resolve all
      await httpRequest(port, "POST", "/tool/result", { callId: "call-a", result: "a" })
      await httpRequest(port, "POST", "/tool/result", { callId: "call-b", result: "b" })
      await httpRequest(port, "POST", "/tool/result", { callId: "call-c", result: "c" })

      const results = await Promise.all(promises)
      for (const r of results) {
        expect((r.body as ToolExecuteResponse).status).toBe("success")
      }

      expect(server.getPendingCount()).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // resolveToolResult() — in-process resolution
  // -------------------------------------------------------------------------

  describe("resolveToolResult()", () => {
    test("resolves a pending call directly (in-process)", async () => {
      server = createIPCServer()
      port = await server.start()

      server.setToolCallHandler(() => {})

      const pendingPromise = httpRequest(port, "POST", "/tool/pending", {
        callId: "call-direct",
        toolName: "bash",
        args: {},
      })

      await new Promise((r) => setTimeout(r, 50))
      expect(server.getPendingCount()).toBe(1)

      // Resolve directly via the in-process method
      server.resolveToolResult({
        callId: "call-direct",
        result: "direct result",
        isError: false,
      })

      const result = await pendingPromise
      const body = result.body as ToolExecuteResponse
      expect(body.status).toBe("success")
      expect(body.result).toBe("direct result")
    })

    test("silently ignores unknown callId", () => {
      server = createIPCServer()
      // Should not throw
      server.resolveToolResult({
        callId: "nonexistent",
        result: "whatever",
      })
    })
  })

  // -------------------------------------------------------------------------
  // setToolCallHandler() — callback and buffering
  // -------------------------------------------------------------------------

  describe("setToolCallHandler()", () => {
    test("notifies handler when a pending call arrives", async () => {
      server = createIPCServer()
      port = await server.start()

      const calls: PendingToolCall[] = []
      server.setToolCallHandler((call) => {
        calls.push(call)
      })

      // Start a pending call
      const pendingPromise = httpRequest(port, "POST", "/tool/pending", {
        callId: "call-notify",
        toolName: "bash",
        args: { command: "ls" },
      })

      await new Promise((r) => setTimeout(r, 50))

      expect(calls).toHaveLength(1)
      expect(calls[0].callId).toBe("call-notify")
      expect(calls[0].toolName).toBe("bash")

      // Clean up
      server.resolveToolResult({ callId: "call-notify", result: "done" })
      await pendingPromise
    })

    test("buffers calls that arrive before handler is registered", async () => {
      server = createIPCServer()
      port = await server.start()

      // Start a pending call WITHOUT a handler registered
      const pendingPromise = httpRequest(port, "POST", "/tool/pending", {
        callId: "call-buffered",
        toolName: "bash",
        args: { command: "ls" },
      })

      await new Promise((r) => setTimeout(r, 50))

      // Now register the handler — should flush the buffered call
      const calls: PendingToolCall[] = []
      server.setToolCallHandler((call) => {
        calls.push(call)
      })

      expect(calls).toHaveLength(1)
      expect(calls[0].callId).toBe("call-buffered")

      // Clean up
      server.resolveToolResult({ callId: "call-buffered", result: "done" })
      await pendingPromise
    })
  })

  // -------------------------------------------------------------------------
  // POST /tool/cancel
  // -------------------------------------------------------------------------

  describe("POST /tool/cancel", () => {
    test("cancels a pending tool call", async () => {
      server = createIPCServer()
      port = await server.start()

      server.setToolCallHandler(() => {})

      // Start a pending call
      const pendingPromise = httpRequest(port, "POST", "/tool/pending", {
        callId: "call-cancel-1",
        toolName: "bash",
        args: {},
      })

      await new Promise((r) => setTimeout(r, 50))
      expect(server.getPendingCount()).toBe(1)

      // Cancel it
      const cancelResult = await httpRequest(port, "POST", "/tool/cancel", {
        callId: "call-cancel-1",
      })

      expect((cancelResult.body as { cancelled: boolean }).cancelled).toBe(true)

      // The pending call should resolve with a cancellation error
      const pendingResult = await pendingPromise
      const body = pendingResult.body as ToolExecuteResponse
      expect(body.status).toBe("error")
      expect(body.code).toBe("TOOL_CANCELLED")

      expect(server.getPendingCount()).toBe(0)
    })

    test("returns cancelled: false for unknown callId", async () => {
      server = createIPCServer()
      port = await server.start()

      const { body } = await httpRequest(port, "POST", "/tool/cancel", {
        callId: "nonexistent",
      })

      expect((body as { cancelled: boolean }).cancelled).toBe(false)
    })

    test("returns error for missing callId", async () => {
      server = createIPCServer()
      port = await server.start()

      const { status } = await httpRequest(port, "POST", "/tool/cancel", {})

      expect(status).toBe(400)
    })
  })

  // -------------------------------------------------------------------------
  // 404 for unknown routes
  // -------------------------------------------------------------------------

  describe("unknown routes", () => {
    test("returns 404 for unknown paths", async () => {
      server = createIPCServer()
      port = await server.start()

      const { status } = await httpRequest(port, "GET", "/unknown")
      expect(status).toBe(404)
    })

    test("returns 404 for wrong method on known path", async () => {
      server = createIPCServer()
      port = await server.start()

      const { status } = await httpRequest(port, "GET", "/tool/pending")
      expect(status).toBe(404)
    })
  })

  // -------------------------------------------------------------------------
  // getPendingCount()
  // -------------------------------------------------------------------------

  describe("getPendingCount()", () => {
    test("returns 0 when no calls are pending", async () => {
      server = createIPCServer()
      port = await server.start()

      expect(server.getPendingCount()).toBe(0)
    })

    test("tracks pending calls", async () => {
      server = createIPCServer()
      port = await server.start()

      server.setToolCallHandler(() => {})

      // Start a pending call (don't await)
      const callPromise = httpRequest(port, "POST", "/tool/pending", {
        callId: "call-pending",
        toolName: "bash",
        args: {},
      })

      // Wait for it to be registered
      await new Promise((r) => setTimeout(r, 50))
      expect(server.getPendingCount()).toBe(1)

      // Resolve the call
      server.resolveToolResult({ callId: "call-pending", result: "done" })
      await callPromise

      expect(server.getPendingCount()).toBe(0)
    })
  })
})
