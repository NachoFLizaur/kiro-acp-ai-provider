// ---------------------------------------------------------------------------
// IPC Server — HTTP server for tool call synchronization with MCP bridge
// ---------------------------------------------------------------------------
//
// Runs in the harness process (via kiro-acp-ai-provider library).
// The MCP bridge subprocess sends HTTP requests to register pending tool calls.
// The adapter resolves them when the harness has executed the tool.
//
// Protocol:
//   POST /tool/pending  — MCP bridge registers a tool call, response held open
//   POST /tool/result   — Adapter sends tool result, unblocks held response
//   POST /tool/cancel   — Rejects a pending tool call
//   GET  /health        — Health check
//
// Uses Node.js `http` module for cross-runtime compatibility (Node + Bun).
// ---------------------------------------------------------------------------

import * as http from "node:http"
import type * as net from "node:net"
import { LaneRouter } from "./lane-router"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A tool call pending execution by the harness. */
export interface PendingToolCall {
  callId: string
  toolName: string
  args: Record<string, unknown>
}

/** Request body for POST /tool/result. */
export interface ToolResultRequest {
  callId: string
  result: string
  isError?: boolean
}

/** Response body for tool-related endpoints. */
export interface ToolExecuteResponse {
  status: "success" | "error" | "ok"
  result?: string
  error?: string
  code?: string
}

/** Options for creating an IPC server. */
export interface IPCServerOptions {
  /** Hostname to bind to. Default: "127.0.0.1". */
  host?: string
}

/** Public interface for the IPC server. */
export interface IPCServer {
  /** Start the server. Returns the assigned port. */
  start(): Promise<number>
  /** Stop the server and reject all pending calls. */
  stop(): Promise<void>
  /** Get the port the server is listening on. */
  getPort(): number | null
  /** Get the number of pending tool calls. */
  getPendingCount(): number
  /** Get the lane router for per-session tool call routing. */
  getLaneRouter(): LaneRouter
  /** Resolve a pending tool call with a result (in-process, used by adapter). */
  resolveToolResult(request: ToolResultRequest): void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read the full request body as a string. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")))
    req.on("error", reject)
  })
}

/** Send a JSON response. */
function respond(res: http.ServerResponse, statusCode: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  })
  res.end(json)
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Internal state for a pending tool call. */
interface PendingCallEntry {
  resolve: (result: ToolExecuteResponse) => void
  reject: (error: Error) => void
  toolName: string
  timer: ReturnType<typeof setTimeout>
}

/** Default timeout for pending tool calls: 5 minutes. */
const PENDING_CALL_TIMEOUT_MS = 300_000

class IPCServerImpl implements IPCServer {
  private server: http.Server | null = null
  private port: number | null = null
  private readonly host: string
  private startTime: number = 0

  /** Pending tool calls waiting for results. Key: callId. */
  private readonly pendingCalls = new Map<string, PendingCallEntry>()

  /** Per-session tool call router. */
  private readonly laneRouter = new LaneRouter()

  constructor(options: IPCServerOptions = {}) {
    this.host = options.host ?? "127.0.0.1"
  }

  async start(): Promise<number> {
    if (this.server) {
      throw new Error("IPC server is already running")
    }

    this.startTime = Date.now()
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch(() => {
        if (!res.headersSent) {
          respond(res, 500, { error: "Internal server error" })
        }
      })
    })

    return new Promise<number>((resolve, reject) => {
      this.server!.listen(0, this.host, () => {
        const addr = this.server!.address() as net.AddressInfo
        this.port = addr.port
        resolve(this.port)
      })
      this.server!.on("error", reject)
    })
  }

  async stop(): Promise<void> {
    // Reject all pending calls
    for (const [callId, entry] of this.pendingCalls) {
      clearTimeout(entry.timer)
      entry.resolve({
        status: "error",
        error: "IPC server shutting down",
        code: "SERVER_SHUTDOWN",
      })
    }
    this.pendingCalls.clear()
    this.laneRouter.clear()

    // Close the HTTP server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve())
      })
      this.server = null
      this.port = null
    }
  }

  getPort(): number | null {
    return this.port
  }

  getPendingCount(): number {
    return this.pendingCalls.size
  }

  getLaneRouter(): LaneRouter {
    return this.laneRouter
  }

  resolveToolResult(request: ToolResultRequest): void {
    const { callId, result, isError } = request
    const pending = this.pendingCalls.get(callId)
    if (!pending) {
      return // Silently ignore — call may have timed out or been cancelled
    }

    clearTimeout(pending.timer)
    this.pendingCalls.delete(callId)

    pending.resolve({
      status: isError ? "error" : "success",
      ...(isError ? { error: result } : { result }),
    })
  }

  // -------------------------------------------------------------------------
  // Request routing
  // -------------------------------------------------------------------------

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method === "GET" && req.url === "/health") {
      return this.handleHealth(res)
    }
    if (req.method === "POST" && req.url === "/tool/pending") {
      return this.handleToolPending(req, res)
    }
    if (req.method === "POST" && req.url === "/tool/result") {
      return this.handleToolResult(req, res)
    }
    if (req.method === "POST" && req.url === "/tool/cancel") {
      return this.handleToolCancel(req, res)
    }

    respond(res, 404, { error: "Not found" })
  }

  // -------------------------------------------------------------------------
  // GET /health
  // -------------------------------------------------------------------------

  private handleHealth(res: http.ServerResponse): void {
    respond(res, 200, {
      status: "ok",
      uptime: Date.now() - this.startTime,
      pendingCalls: this.pendingCalls.size,
    })
  }

  // -------------------------------------------------------------------------
  // POST /tool/pending — Hold-and-wait pattern
  // -------------------------------------------------------------------------

  private async handleToolPending(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // Parse request body
    let body: { callId?: string; toolName?: string; args?: Record<string, unknown> }
    try {
      const raw = await readBody(req)
      body = JSON.parse(raw) as typeof body
    } catch {
      respond(res, 400, {
        status: "error",
        error: "Invalid JSON in request body",
        code: "INVALID_REQUEST",
      })
      return
    }

    // Validate required fields
    if (!body.callId || !body.toolName) {
      respond(res, 400, {
        status: "error",
        error: "Missing required fields: callId and toolName",
        code: "INVALID_REQUEST",
      })
      return
    }

    const { callId, toolName, args = {} } = body

    // Create a promise that will be resolved when /tool/result is called
    // or when resolveToolResult() is called directly
    const resultPromise = new Promise<ToolExecuteResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(callId)
        resolve({
          status: "error",
          error: "Tool call timed out waiting for result from harness",
          code: "TOOL_TIMEOUT",
        })
      }, PENDING_CALL_TIMEOUT_MS)

      this.pendingCalls.set(callId, { resolve, reject, toolName, timer })
    })

    // Notify the adapter that a tool call is pending via the lane router
    const pendingCall: PendingToolCall = { callId, toolName, args }
    this.laneRouter.route(pendingCall)

    // Hold the HTTP response open until the promise resolves
    const result = await resultPromise
    respond(res, 200, result)
  }

  // -------------------------------------------------------------------------
  // POST /tool/result
  // -------------------------------------------------------------------------

  private async handleToolResult(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: ToolResultRequest
    try {
      const raw = await readBody(req)
      body = JSON.parse(raw) as ToolResultRequest
    } catch {
      respond(res, 400, {
        status: "error",
        error: "Invalid JSON in request body",
        code: "INVALID_REQUEST",
      })
      return
    }

    if (!body.callId) {
      respond(res, 400, {
        status: "error",
        error: "Missing required field: callId",
        code: "INVALID_REQUEST",
      })
      return
    }

    const pending = this.pendingCalls.get(body.callId)
    if (!pending) {
      respond(res, 404, {
        status: "error",
        error: `No pending call: ${body.callId}`,
        code: "NOT_FOUND",
      })
      return
    }

    clearTimeout(pending.timer)
    this.pendingCalls.delete(body.callId)

    // Resolve the held promise, which releases the MCP bridge's HTTP response
    pending.resolve({
      status: body.isError ? "error" : "success",
      ...(body.isError ? { error: body.result } : { result: body.result }),
    })

    respond(res, 200, { status: "ok" })
  }

  // -------------------------------------------------------------------------
  // POST /tool/cancel
  // -------------------------------------------------------------------------

  private async handleToolCancel(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: { callId?: string }
    try {
      const raw = await readBody(req)
      body = JSON.parse(raw) as { callId?: string }
    } catch {
      respond(res, 400, { error: "Invalid JSON in request body" })
      return
    }

    if (!body.callId) {
      respond(res, 400, { error: "Missing required field: callId" })
      return
    }

    const pending = this.pendingCalls.get(body.callId)
    if (pending) {
      clearTimeout(pending.timer)
      this.pendingCalls.delete(body.callId)
      pending.resolve({
        status: "error",
        error: "Tool execution was cancelled",
        code: "TOOL_CANCELLED",
      })
      respond(res, 200, { status: "ok", cancelled: true })
    } else {
      respond(res, 200, { status: "ok", cancelled: false })
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a new IPC server instance. */
export function createIPCServer(options: IPCServerOptions = {}): IPCServer {
  return new IPCServerImpl(options)
}
