import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import {
  createIPCServer,
  type IPCServer,
  type ToolExecutorFn,
  type ToolExecuteRequest,
  type ToolExecuteResponse,
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

  // Default executor that echoes the tool name and args
  const echoExecutor: ToolExecutorFn = async (request) => {
    return `Executed ${request.toolName} with args: ${JSON.stringify(request.args)}`
  }

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
      server = createIPCServer({ toolExecutor: echoExecutor })
      port = await server.start()

      expect(port).toBeGreaterThan(0)
      expect(port).toBeLessThan(65536)
      expect(server.getPort()).toBe(port)
    })

    test("throws if started twice", async () => {
      server = createIPCServer({ toolExecutor: echoExecutor })
      await server.start()

      expect(server.start()).rejects.toThrow("already running")
    })
  })

  describe("stop()", () => {
    test("cleans up and resets port to null", async () => {
      server = createIPCServer({ toolExecutor: echoExecutor })
      port = await server.start()

      expect(server.getPort()).toBe(port)

      await server.stop()

      expect(server.getPort()).toBeNull()
    })

    test("is safe to call when not started", async () => {
      server = createIPCServer({ toolExecutor: echoExecutor })
      // Should not throw
      await server.stop()
    })

    test("aborts in-flight calls on stop", async () => {
      let receivedSignal: AbortSignal | null = null

      const slowExecutor: ToolExecutorFn = async (_request, signal) => {
        receivedSignal = signal
        // Wait indefinitely (will be aborted)
        return new Promise((resolve, reject) => {
          const onAbort = () => reject(new Error("Aborted"))
          if (signal.aborted) {
            reject(new Error("Aborted"))
            return
          }
          signal.addEventListener("abort", onAbort, { once: true })
        })
      }

      server = createIPCServer({ toolExecutor: slowExecutor })
      port = await server.start()

      // Start a tool call (don't await it)
      const callPromise = httpRequest(port, "POST", "/tool/execute", {
        toolName: "slow_tool",
        toolCallId: "call-1",
        args: {},
        timeout: 60_000,
      })

      // Give the request time to reach the server
      await new Promise((r) => setTimeout(r, 50))

      expect(server.getPendingCount()).toBe(1)

      // Stop the server — should abort the in-flight call
      await server.stop()

      expect(server.getPendingCount()).toBe(0)

      // The HTTP request should complete (with an error response or connection error)
      // Since the server is closing, the response may be an abort/cancel error
      try {
        const result = await callPromise
        // If we get a response, it should indicate cancellation/timeout
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
      server = createIPCServer({ toolExecutor: echoExecutor })
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
  // POST /tool/execute
  // -------------------------------------------------------------------------

  describe("POST /tool/execute", () => {
    test("executes a tool and returns success result", async () => {
      server = createIPCServer({ toolExecutor: echoExecutor })
      port = await server.start()

      const { status, body } = await httpRequest(port, "POST", "/tool/execute", {
        toolName: "task",
        toolCallId: "call-1",
        args: { description: "test task" },
      })

      expect(status).toBe(200)
      const result = body as ToolExecuteResponse
      expect(result.status).toBe("success")
      expect(result.result).toContain("Executed task")
      expect(result.result).toContain("test task")
    })

    test("returns error when executor throws", async () => {
      const failingExecutor: ToolExecutorFn = async () => {
        throw new Error("Tool execution failed: something went wrong")
      }

      server = createIPCServer({ toolExecutor: failingExecutor })
      port = await server.start()

      const { status, body } = await httpRequest(port, "POST", "/tool/execute", {
        toolName: "broken_tool",
        toolCallId: "call-2",
        args: {},
      })

      expect(status).toBe(200)
      const result = body as ToolExecuteResponse
      expect(result.status).toBe("error")
      expect(result.error).toContain("something went wrong")
      expect(result.code).toBe("TOOL_EXECUTION_FAILED")
    })

    test("returns INVALID_REQUEST for malformed JSON", async () => {
      server = createIPCServer({ toolExecutor: echoExecutor })
      port = await server.start()

      const response = await fetch(`http://127.0.0.1:${port}/tool/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json{{{",
      })

      expect(response.status).toBe(400)
      const result = (await response.json()) as ToolExecuteResponse
      expect(result.status).toBe("error")
      expect(result.code).toBe("INVALID_REQUEST")
    })

    test("returns INVALID_REQUEST for missing required fields", async () => {
      server = createIPCServer({ toolExecutor: echoExecutor })
      port = await server.start()

      const { status, body } = await httpRequest(port, "POST", "/tool/execute", {
        args: {},
      })

      expect(status).toBe(400)
      const result = body as ToolExecuteResponse
      expect(result.status).toBe("error")
      expect(result.code).toBe("INVALID_REQUEST")
    })

    test("passes sessionId and args to executor", async () => {
      let receivedRequest: ToolExecuteRequest | null = null

      const captureExecutor: ToolExecutorFn = async (request) => {
        receivedRequest = request
        return "ok"
      }

      server = createIPCServer({ toolExecutor: captureExecutor })
      port = await server.start()

      await httpRequest(port, "POST", "/tool/execute", {
        toolName: "question",
        toolCallId: "call-3",
        args: { prompt: "Are you sure?" },
        sessionId: "sess-abc",
        timeout: 60_000,
      })

      expect(receivedRequest).not.toBeNull()
      expect(receivedRequest!.toolName).toBe("question")
      expect(receivedRequest!.toolCallId).toBe("call-3")
      expect(receivedRequest!.args).toEqual({ prompt: "Are you sure?" })
      expect(receivedRequest!.sessionId).toBe("sess-abc")
      expect(receivedRequest!.timeout).toBe(60_000)
    })

    test("provides AbortSignal to executor", async () => {
      let receivedSignal: AbortSignal | null = null

      const signalExecutor: ToolExecutorFn = async (_request, signal) => {
        receivedSignal = signal
        return "done"
      }

      server = createIPCServer({ toolExecutor: signalExecutor })
      port = await server.start()

      await httpRequest(port, "POST", "/tool/execute", {
        toolName: "task",
        toolCallId: "call-4",
        args: {},
      })

      expect(receivedSignal).not.toBeNull()
      expect(receivedSignal!.aborted).toBe(false)
    })

    test("handles timeout by aborting the signal", async () => {
      const slowExecutor: ToolExecutorFn = async (_request, signal) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve("done"), 10_000)
          signal.addEventListener("abort", () => {
            clearTimeout(timer)
            reject(new Error("Aborted"))
          }, { once: true })
        })
      }

      server = createIPCServer({ toolExecutor: slowExecutor })
      port = await server.start()

      const { status, body } = await httpRequest(port, "POST", "/tool/execute", {
        toolName: "slow_tool",
        toolCallId: "call-5",
        args: {},
        timeout: 100, // Very short timeout
      })

      expect(status).toBe(200)
      const result = body as ToolExecuteResponse
      expect(result.status).toBe("error")
      expect(result.code).toBe("TOOL_TIMEOUT")
    })

    test("handles concurrent tool calls", async () => {
      let concurrentCount = 0
      let maxConcurrent = 0

      const concurrentExecutor: ToolExecutorFn = async (request) => {
        concurrentCount++
        maxConcurrent = Math.max(maxConcurrent, concurrentCount)
        await new Promise((r) => setTimeout(r, 50))
        concurrentCount--
        return `Result for ${request.toolCallId}`
      }

      server = createIPCServer({ toolExecutor: concurrentExecutor })
      port = await server.start()

      // Send 3 concurrent requests
      const results = await Promise.all([
        httpRequest(port, "POST", "/tool/execute", {
          toolName: "task",
          toolCallId: "call-a",
          args: {},
        }),
        httpRequest(port, "POST", "/tool/execute", {
          toolName: "task",
          toolCallId: "call-b",
          args: {},
        }),
        httpRequest(port, "POST", "/tool/execute", {
          toolName: "task",
          toolCallId: "call-c",
          args: {},
        }),
      ])

      // All should succeed
      for (const { body } of results) {
        const result = body as ToolExecuteResponse
        expect(result.status).toBe("success")
      }

      // Should have been concurrent
      expect(maxConcurrent).toBeGreaterThanOrEqual(2)
    })
  })

  // -------------------------------------------------------------------------
  // POST /tool/cancel
  // -------------------------------------------------------------------------

  describe("POST /tool/cancel", () => {
    test("cancels an in-flight tool call", async () => {
      let abortedViaSignal = false

      const cancellableExecutor: ToolExecutorFn = async (_request, signal) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve("done"), 10_000)
          signal.addEventListener("abort", () => {
            clearTimeout(timer)
            abortedViaSignal = true
            reject(new Error("Cancelled"))
          }, { once: true })
        })
      }

      server = createIPCServer({ toolExecutor: cancellableExecutor })
      port = await server.start()

      // Start a long-running tool call
      const executePromise = httpRequest(port, "POST", "/tool/execute", {
        toolName: "task",
        toolCallId: "call-cancel-1",
        args: {},
        timeout: 60_000,
      })

      // Wait for the call to be registered
      await new Promise((r) => setTimeout(r, 50))
      expect(server.getPendingCount()).toBe(1)

      // Cancel it
      const cancelResult = await httpRequest(port, "POST", "/tool/cancel", {
        toolCallId: "call-cancel-1",
      })

      expect((cancelResult.body as { cancelled: boolean }).cancelled).toBe(true)

      // The execute request should complete with a cancellation error
      const executeResult = await executePromise
      const body = executeResult.body as ToolExecuteResponse
      expect(body.status).toBe("error")
      expect(body.code).toBe("TOOL_CANCELLED")

      // The signal should have been aborted
      expect(abortedViaSignal).toBe(true)
    })

    test("returns cancelled: false for unknown toolCallId", async () => {
      server = createIPCServer({ toolExecutor: echoExecutor })
      port = await server.start()

      const { body } = await httpRequest(port, "POST", "/tool/cancel", {
        toolCallId: "nonexistent",
      })

      expect((body as { cancelled: boolean }).cancelled).toBe(false)
    })

    test("returns error for missing toolCallId", async () => {
      server = createIPCServer({ toolExecutor: echoExecutor })
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
      server = createIPCServer({ toolExecutor: echoExecutor })
      port = await server.start()

      const { status } = await httpRequest(port, "GET", "/unknown")
      expect(status).toBe(404)
    })

    test("returns 404 for wrong method on known path", async () => {
      server = createIPCServer({ toolExecutor: echoExecutor })
      port = await server.start()

      const { status } = await httpRequest(port, "GET", "/tool/execute")
      expect(status).toBe(404)
    })
  })

  // -------------------------------------------------------------------------
  // getPendingCount()
  // -------------------------------------------------------------------------

  describe("getPendingCount()", () => {
    test("returns 0 when no calls are in flight", async () => {
      server = createIPCServer({ toolExecutor: echoExecutor })
      port = await server.start()

      expect(server.getPendingCount()).toBe(0)
    })

    test("tracks in-flight calls", async () => {
      let resolveCall: (() => void) | null = null

      const blockingExecutor: ToolExecutorFn = async () => {
        return new Promise<string>((resolve) => {
          resolveCall = () => resolve("done")
        })
      }

      server = createIPCServer({ toolExecutor: blockingExecutor })
      port = await server.start()

      // Start a call (don't await)
      const callPromise = httpRequest(port, "POST", "/tool/execute", {
        toolName: "task",
        toolCallId: "call-pending",
        args: {},
      })

      // Wait for it to be registered
      await new Promise((r) => setTimeout(r, 50))
      expect(server.getPendingCount()).toBe(1)

      // Resolve the call
      resolveCall!()
      await callPromise

      expect(server.getPendingCount()).toBe(0)
    })
  })
})
