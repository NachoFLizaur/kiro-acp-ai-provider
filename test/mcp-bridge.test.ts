import { describe, test, expect, afterEach } from "bun:test"
import {
  createIPCServer,
  type IPCServer,
  type ToolExecuteResponse,
} from "../src/ipc-server"

// ---------------------------------------------------------------------------
// MCP Bridge Content Conversion Tests
//
// The MCP bridge (`src/mcp-bridge.ts`) is a standalone process with private
// methods. Direct unit testing of `delegateToIPC()` is not feasible without
// exporting the class.
//
// Instead, we test the content conversion path end-to-end through the IPC
// server. The bridge's `delegateToIPC()` method:
//   1. POSTs to /tool/pending on the IPC server
//   2. Receives a ToolExecuteResponse (which may include `content`)
//   3. Converts content blocks to MCP format
//
// These tests verify that the IPC server correctly passes through content
// blocks in the format that the MCP bridge expects. The bridge's conversion
// logic (IPC content → MCP content) is a direct mapping:
//   - { type: "image", data, mimeType } → { type: "image", data, mimeType }
//   - { type: "text", text } → { type: "text", text }
//
// This validates the contract between IPC server and MCP bridge.
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

describe("MCP Bridge content conversion (via IPC)", () => {
  let server: IPCServer
  let port: number
  let secret: string

  afterEach(async () => {
    if (server) {
      await server.stop()
    }
  })

  test("delegateToIPC returns image content blocks from IPC response", async () => {
    // This simulates what the MCP bridge receives when the IPC server
    // resolves a tool call with image content blocks.
    server = createIPCServer()
    port = await server.start()
    secret = server.getSecret()

    server.getLaneRouter().register("sess-1", () => {})

    // Simulate the bridge posting a tool call (what delegateToIPC does)
    const pendingPromise = httpRequest(port, "POST", "/tool/pending", {
      callId: "bridge-img-1",
      toolName: "screenshot",
      args: {},
    }, secret)

    await new Promise((r) => setTimeout(r, 50))

    // Simulate the harness resolving with image content
    server.resolveToolResult({
      callId: "bridge-img-1",
      result: "Screenshot taken",
      isError: false,
      content: [
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ],
    })

    const result = await pendingPromise
    const body = result.body as ToolExecuteResponse

    // The bridge would receive this response and convert to MCP format.
    // Verify the IPC response has the content the bridge needs.
    expect(body.status).toBe("success")
    expect(body.content).toBeDefined()
    expect(body.content).toHaveLength(1)
    expect(body.content![0]).toEqual({
      type: "image",
      data: "iVBORw0KGgo=",
      mimeType: "image/png",
    })
  })

  test("delegateToIPC falls back to text when no content field", async () => {
    // When the IPC response has no content field, the bridge falls back
    // to wrapping response.result in a text content block.
    server = createIPCServer()
    port = await server.start()
    secret = server.getSecret()

    server.getLaneRouter().register("sess-1", () => {})

    const pendingPromise = httpRequest(port, "POST", "/tool/pending", {
      callId: "bridge-text-1",
      toolName: "bash",
      args: { command: "echo hello" },
    }, secret)

    await new Promise((r) => setTimeout(r, 50))

    // Resolve with text-only result (no content field)
    server.resolveToolResult({
      callId: "bridge-text-1",
      result: "hello\n",
      isError: false,
    })

    const result = await pendingPromise
    const body = result.body as ToolExecuteResponse

    expect(body.status).toBe("success")
    expect(body.result).toBe("hello\n")
    // No content field — bridge will use result as text fallback
    expect(body.content).toBeUndefined()
  })

  test("delegateToIPC handles mixed text + image content", async () => {
    server = createIPCServer()
    port = await server.start()
    secret = server.getSecret()

    server.getLaneRouter().register("sess-1", () => {})

    const pendingPromise = httpRequest(port, "POST", "/tool/pending", {
      callId: "bridge-mixed-1",
      toolName: "render",
      args: {},
    }, secret)

    await new Promise((r) => setTimeout(r, 50))

    // Resolve with mixed content
    server.resolveToolResult({
      callId: "bridge-mixed-1",
      result: "Rendered output",
      isError: false,
      content: [
        { type: "text", text: "Rendered output" },
        { type: "image", data: "pngBase64Data", mimeType: "image/png" },
        { type: "text", text: "Additional notes" },
        { type: "image", data: "jpgBase64Data", mimeType: "image/jpeg" },
      ],
    })

    const result = await pendingPromise
    const body = result.body as ToolExecuteResponse

    expect(body.status).toBe("success")
    expect(body.content).toBeDefined()
    expect(body.content).toHaveLength(4)
    expect(body.content![0]).toEqual({ type: "text", text: "Rendered output" })
    expect(body.content![1]).toEqual({ type: "image", data: "pngBase64Data", mimeType: "image/png" })
    expect(body.content![2]).toEqual({ type: "text", text: "Additional notes" })
    expect(body.content![3]).toEqual({ type: "image", data: "jpgBase64Data", mimeType: "image/jpeg" })
  })

  test("delegateToIPC error path remains text-only", async () => {
    server = createIPCServer()
    port = await server.start()
    secret = server.getSecret()

    server.getLaneRouter().register("sess-1", () => {})

    const pendingPromise = httpRequest(port, "POST", "/tool/pending", {
      callId: "bridge-err-1",
      toolName: "bash",
      args: { command: "false" },
    }, secret)

    await new Promise((r) => setTimeout(r, 50))

    // Resolve with error — no content field
    server.resolveToolResult({
      callId: "bridge-err-1",
      result: "Command failed with exit code 1",
      isError: true,
    })

    const result = await pendingPromise
    const body = result.body as ToolExecuteResponse

    // Error responses use the error field, not content
    expect(body.status).toBe("error")
    expect(body.error).toBe("Command failed with exit code 1")
    expect(body.content).toBeUndefined()
  })
})
