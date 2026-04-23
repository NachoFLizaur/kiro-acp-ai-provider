import { describe, test, expect, afterEach } from "bun:test"
import {
  createIPCServer,
  type IPCServer,
  type ToolExecuteResponse,
  type PendingToolCall,
} from "../src/ipc-server"
import { LaneRouter } from "../src/lane-router"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make an HTTP request to the IPC server and return parsed JSON. */
async function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  authToken?: string,
): Promise<{ status: number; body: unknown }> {
  const url = `http://127.0.0.1:${port}${path}`
  const headers: Record<string, string> = {}
  if (body) headers["Content-Type"] = "application/json"
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`
  const options: RequestInit = {
    method,
    headers,
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
  let secret: string

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
      secret = server.getSecret()

      // Register a lane so the call gets routed
      const router = server.getLaneRouter()
      router.register("sess-1", () => {
        // Don't resolve — let it stay pending
      })

      // Start a pending tool call (don't await it)
      const callPromise = httpRequest(port, "POST", "/tool/pending", {
        callId: "call-1",
        toolName: "bash",
        args: { command: "ls" },
      }, secret)

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
  // Authentication
  // -------------------------------------------------------------------------

  describe("authentication", () => {
    test("returns 401 for requests without Authorization header", async () => {
      server = createIPCServer()
      port = await server.start()

      const { status } = await httpRequest(port, "POST", "/tool/pending", {
        callId: "call-1",
        toolName: "bash",
        args: {},
      })

      expect(status).toBe(401)
    })

    test("returns 401 for requests with invalid token", async () => {
      server = createIPCServer()
      port = await server.start()

      const { status } = await httpRequest(port, "POST", "/tool/pending", {
        callId: "call-1",
        toolName: "bash",
        args: {},
      }, "wrong-token")

      expect(status).toBe(401)
    })

    test("health endpoint does not require authentication", async () => {
      server = createIPCServer()
      port = await server.start()

      const { status } = await httpRequest(port, "GET", "/health")
      expect(status).toBe(200)
    })

    test("getSecret() returns a non-empty hex string", () => {
      server = createIPCServer()
      secret = server.getSecret()

      expect(secret).toBeTruthy()
      expect(secret).toMatch(/^[a-f0-9]+$/)
      expect(secret.length).toBe(64) // 32 bytes = 64 hex chars
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
      secret = server.getSecret()

      // Register a lane to capture the tool call
      let receivedCall: PendingToolCall | null = null
      const router = server.getLaneRouter()
      router.register("sess-1", (call) => {
        receivedCall = call
      })

      // Start a pending call (don't await — it blocks)
      const pendingPromise = httpRequest(port, "POST", "/tool/pending", {
        callId: "call-1",
        toolName: "bash",
        args: { command: "echo hello" },
      }, secret)

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
      }, secret)

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
      secret = server.getSecret()

      server.getLaneRouter().register("sess-1", () => {})

      const pendingPromise = httpRequest(port, "POST", "/tool/pending", {
        callId: "call-err",
        toolName: "bash",
        args: { command: "false" },
      }, secret)

      await new Promise((r) => setTimeout(r, 50))

      await httpRequest(port, "POST", "/tool/result", {
        callId: "call-err",
        result: "Command failed with exit code 1",
        isError: true,
      }, secret)

      const pendingResult = await pendingPromise
      const body = pendingResult.body as ToolExecuteResponse
      expect(body.status).toBe("error")
      expect(body.error).toBe("Command failed with exit code 1")
    })

    test("returns 404 for /tool/result with unknown callId", async () => {
      server = createIPCServer()
      port = await server.start()
      secret = server.getSecret()

      const { status, body } = await httpRequest(port, "POST", "/tool/result", {
        callId: "nonexistent",
        result: "some result",
      }, secret)

      expect(status).toBe(404)
      expect((body as { code: string }).code).toBe("NOT_FOUND")
    })

    test("returns INVALID_REQUEST for malformed JSON on /tool/pending", async () => {
      server = createIPCServer()
      port = await server.start()
      secret = server.getSecret()

      const response = await fetch(`http://127.0.0.1:${port}/tool/pending`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${secret}`,
        },
        body: "not valid json{{{",
      })

      expect(response.status).toBe(400)
      const result = (await response.json()) as ToolExecuteResponse
      expect(result.code).toBe("INVALID_REQUEST")
    })

    test("returns INVALID_REQUEST for missing required fields on /tool/pending", async () => {
      server = createIPCServer()
      port = await server.start()
      secret = server.getSecret()

      const { status, body } = await httpRequest(port, "POST", "/tool/pending", {
        args: {},
      }, secret)

      expect(status).toBe(400)
      expect((body as { code: string }).code).toBe("INVALID_REQUEST")
    })

    test("handles concurrent pending calls", async () => {
      server = createIPCServer()
      port = await server.start()
      secret = server.getSecret()

      const receivedCalls: PendingToolCall[] = []
      server.getLaneRouter().register("sess-1", (call) => {
        receivedCalls.push(call)
      })

      // Start 3 concurrent pending calls
      const promises = [
        httpRequest(port, "POST", "/tool/pending", {
          callId: "call-a",
          toolName: "bash",
          args: { command: "echo a" },
        }, secret),
        httpRequest(port, "POST", "/tool/pending", {
          callId: "call-b",
          toolName: "read_file",
          args: { filePath: "/tmp/test" },
        }, secret),
        httpRequest(port, "POST", "/tool/pending", {
          callId: "call-c",
          toolName: "glob",
          args: { pattern: "*.ts" },
        }, secret),
      ]

      await new Promise((r) => setTimeout(r, 50))
      expect(server.getPendingCount()).toBe(3)
      expect(receivedCalls).toHaveLength(3)

      // Resolve all
      await httpRequest(port, "POST", "/tool/result", { callId: "call-a", result: "a" }, secret)
      await httpRequest(port, "POST", "/tool/result", { callId: "call-b", result: "b" }, secret)
      await httpRequest(port, "POST", "/tool/result", { callId: "call-c", result: "c" }, secret)

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
      secret = server.getSecret()

      server.getLaneRouter().register("sess-1", () => {})

      const pendingPromise = httpRequest(port, "POST", "/tool/pending", {
        callId: "call-direct",
        toolName: "bash",
        args: {},
      }, secret)

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
  // getLaneRouter() — lane-based routing
  // -------------------------------------------------------------------------

  describe("getLaneRouter()", () => {
    test("notifies lane handler when a pending call arrives", async () => {
      server = createIPCServer()
      port = await server.start()
      secret = server.getSecret()

      const calls: PendingToolCall[] = []
      server.getLaneRouter().register("sess-1", (call) => {
        calls.push(call)
      })

      // Start a pending call
      const pendingPromise = httpRequest(port, "POST", "/tool/pending", {
        callId: "call-notify",
        toolName: "bash",
        args: { command: "ls" },
      }, secret)

      await new Promise((r) => setTimeout(r, 50))

      expect(calls).toHaveLength(1)
      expect(calls[0].callId).toBe("call-notify")
      expect(calls[0].toolName).toBe("bash")

      // Clean up
      server.resolveToolResult({ callId: "call-notify", result: "done" })
      await pendingPromise
    })

    test("buffers calls that arrive before a lane is registered", async () => {
      server = createIPCServer()
      port = await server.start()
      secret = server.getSecret()

      // Start a pending call WITHOUT a lane registered
      const pendingPromise = httpRequest(port, "POST", "/tool/pending", {
        callId: "call-buffered",
        toolName: "bash",
        args: { command: "ls" },
      }, secret)

      await new Promise((r) => setTimeout(r, 50))

      // Now register a lane — should flush the buffered call
      const calls: PendingToolCall[] = []
      server.getLaneRouter().register("sess-1", (call) => {
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
      secret = server.getSecret()

      server.getLaneRouter().register("sess-1", () => {})

      // Start a pending call
      const pendingPromise = httpRequest(port, "POST", "/tool/pending", {
        callId: "call-cancel-1",
        toolName: "bash",
        args: {},
      }, secret)

      await new Promise((r) => setTimeout(r, 50))
      expect(server.getPendingCount()).toBe(1)

      // Cancel it
      const cancelResult = await httpRequest(port, "POST", "/tool/cancel", {
        callId: "call-cancel-1",
      }, secret)

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
      secret = server.getSecret()

      const { body } = await httpRequest(port, "POST", "/tool/cancel", {
        callId: "nonexistent",
      }, secret)

      expect((body as { cancelled: boolean }).cancelled).toBe(false)
    })

    test("returns error for missing callId", async () => {
      server = createIPCServer()
      port = await server.start()
      secret = server.getSecret()

      const { status } = await httpRequest(port, "POST", "/tool/cancel", {}, secret)

      expect(status).toBe(400)
    })
  })

  // -------------------------------------------------------------------------
  // 404 for unknown routes (with valid auth)
  // -------------------------------------------------------------------------

  describe("unknown routes", () => {
    test("returns 401 for unknown paths without auth", async () => {
      server = createIPCServer()
      port = await server.start()

      const { status } = await httpRequest(port, "GET", "/unknown")
      expect(status).toBe(401)
    })

    test("returns 404 for unknown paths with valid auth", async () => {
      server = createIPCServer()
      port = await server.start()
      secret = server.getSecret()

      const { status } = await httpRequest(port, "POST", "/unknown", {}, secret)
      expect(status).toBe(404)
    })

    test("returns 404 for wrong method on known path", async () => {
      server = createIPCServer()
      port = await server.start()
      secret = server.getSecret()

      // GET /tool/pending with auth — should be 404 (wrong method)
      const { status } = await httpRequest(port, "GET", "/tool/pending", undefined, secret)
      expect(status).toBe(404)
    })
  })

  // -------------------------------------------------------------------------
  // Image content support
  // -------------------------------------------------------------------------

  describe("Image content support", () => {
    test("tool result with content field passes through to pending response", async () => {
      server = createIPCServer()
      port = await server.start()
      secret = server.getSecret()

      server.getLaneRouter().register("sess-1", () => {})

      const pendingPromise = httpRequest(port, "POST", "/tool/pending", {
        callId: "call-img-1",
        toolName: "screenshot",
        args: {},
      }, secret)

      await new Promise((r) => setTimeout(r, 50))
      expect(server.getPendingCount()).toBe(1)

      // Send result with content field including an image block
      await httpRequest(port, "POST", "/tool/result", {
        callId: "call-img-1",
        result: "Screenshot captured",
        isError: false,
        content: [
          { type: "text", text: "Screenshot captured" },
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        ],
      }, secret)

      const pendingResult = await pendingPromise
      const body = pendingResult.body as ToolExecuteResponse
      expect(body.status).toBe("success")
      expect(body.result).toBe("Screenshot captured")
      expect(body.content).toBeDefined()
      expect(body.content).toHaveLength(2)
      expect(body.content![0]).toEqual({ type: "text", text: "Screenshot captured" })
      expect(body.content![1]).toEqual({ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" })
    })

    test("tool result without content field works as before", async () => {
      server = createIPCServer()
      port = await server.start()
      secret = server.getSecret()

      server.getLaneRouter().register("sess-1", () => {})

      const pendingPromise = httpRequest(port, "POST", "/tool/pending", {
        callId: "call-text-only",
        toolName: "bash",
        args: { command: "echo hello" },
      }, secret)

      await new Promise((r) => setTimeout(r, 50))

      // Send result WITHOUT content field — backward compatible
      await httpRequest(port, "POST", "/tool/result", {
        callId: "call-text-only",
        result: "hello\n",
        isError: false,
      }, secret)

      const pendingResult = await pendingPromise
      const body = pendingResult.body as ToolExecuteResponse
      expect(body.status).toBe("success")
      expect(body.result).toBe("hello\n")
      expect(body.content).toBeUndefined()
    })

    test("tool result with mixed text + image content", async () => {
      server = createIPCServer()
      port = await server.start()
      secret = server.getSecret()

      server.getLaneRouter().register("sess-1", () => {})

      const pendingPromise = httpRequest(port, "POST", "/tool/pending", {
        callId: "call-mixed",
        toolName: "render",
        args: {},
      }, secret)

      await new Promise((r) => setTimeout(r, 50))

      const mixedContent = [
        { type: "text", text: "Rendered output:" },
        { type: "image", data: "base64png", mimeType: "image/png" },
        { type: "text", text: "And another view:" },
        { type: "image", data: "base64jpg", mimeType: "image/jpeg" },
      ]

      await httpRequest(port, "POST", "/tool/result", {
        callId: "call-mixed",
        result: "Rendered output:",
        isError: false,
        content: mixedContent,
      }, secret)

      const pendingResult = await pendingPromise
      const body = pendingResult.body as ToolExecuteResponse
      expect(body.status).toBe("success")
      expect(body.content).toHaveLength(4)
      expect(body.content![0]).toEqual({ type: "text", text: "Rendered output:" })
      expect(body.content![1]).toEqual({ type: "image", data: "base64png", mimeType: "image/png" })
      expect(body.content![2]).toEqual({ type: "text", text: "And another view:" })
      expect(body.content![3]).toEqual({ type: "image", data: "base64jpg", mimeType: "image/jpeg" })
    })

    test("resolveToolResult passes content to pending promise", async () => {
      server = createIPCServer()
      port = await server.start()
      secret = server.getSecret()

      server.getLaneRouter().register("sess-1", () => {})

      const pendingPromise = httpRequest(port, "POST", "/tool/pending", {
        callId: "call-resolve-content",
        toolName: "screenshot",
        args: {},
      }, secret)

      await new Promise((r) => setTimeout(r, 50))
      expect(server.getPendingCount()).toBe(1)

      // Resolve directly via the in-process method with content
      server.resolveToolResult({
        callId: "call-resolve-content",
        result: "Screenshot taken",
        isError: false,
        content: [
          { type: "image", data: "resolvedBase64", mimeType: "image/webp" },
        ],
      })

      const result = await pendingPromise
      const body = result.body as ToolExecuteResponse
      expect(body.status).toBe("success")
      expect(body.result).toBe("Screenshot taken")
      expect(body.content).toBeDefined()
      expect(body.content).toHaveLength(1)
      expect(body.content![0]).toEqual({ type: "image", data: "resolvedBase64", mimeType: "image/webp" })
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
      secret = server.getSecret()

      server.getLaneRouter().register("sess-1", () => {})

      // Start a pending call (don't await)
      const callPromise = httpRequest(port, "POST", "/tool/pending", {
        callId: "call-pending",
        toolName: "bash",
        args: {},
      }, secret)

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
