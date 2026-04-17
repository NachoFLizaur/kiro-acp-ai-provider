// ---------------------------------------------------------------------------
// IPC Server — HTTP server for tool call synchronization with MCP bridge
// ---------------------------------------------------------------------------
//
// Protocol:
//   POST /tool/pending  — MCP bridge registers a tool call, response held open
//   POST /tool/result   — Adapter sends tool result, unblocks held response
//   POST /tool/cancel   — Rejects a pending tool call
//   GET  /health        — Health check
// ---------------------------------------------------------------------------

import * as http from "node:http"
import type * as net from "node:net"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { LaneRouter } from "./lane-router"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingToolCall {
  callId: string
  toolName: string
  args: Record<string, unknown>
}

export interface ToolResultRequest {
  callId: string
  result: string
  isError?: boolean
}

export interface ToolExecuteResponse {
  status: "success" | "error" | "ok"
  result?: string
  error?: string
  code?: string
}

export interface IPCServerOptions {
  host?: string
}

export interface IPCServer {
  start(): Promise<number>
  stop(): Promise<void>
  getPort(): number | null
  getSecret(): string
  getPendingCount(): number
  getLaneRouter(): LaneRouter
  resolveToolResult(request: ToolResultRequest): void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    const chunks: Buffer[] = []
    let totalSize = 0
    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length
      if (totalSize > MAX_BODY_SIZE) {
        if (!settled) { settled = true; reject(new Error("PAYLOAD_TOO_LARGE")) }
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString("utf-8")) } })
    req.on("error", (err) => { if (!settled) { settled = true; reject(err) } })
  })
}

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

interface PendingCallEntry {
  resolve: (result: ToolExecuteResponse) => void
  reject: (error: Error) => void
  toolName: string
  timer: ReturnType<typeof setTimeout>
}

const PENDING_CALL_TIMEOUT_MS = 300_000
const MAX_BODY_SIZE = 10 * 1024 * 1024 // 10 MB
const MAX_PENDING_CALLS = 1_000

class IPCServerImpl implements IPCServer {
  private server: http.Server | null = null
  private port: number | null = null
  private readonly host: string
  private startTime: number = 0
  private readonly pendingCalls = new Map<string, PendingCallEntry>()
  private readonly laneRouter = new LaneRouter()
  private readonly secret: string

  constructor(options: IPCServerOptions = {}) {
    this.host = options.host ?? "127.0.0.1"
    this.secret = randomBytes(32).toString("hex")
  }

  async start(): Promise<number> {
    if (this.server) {
      throw new Error("IPC server is already running")
    }

    this.startTime = Date.now()
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          if (err instanceof Error && err.message === "PAYLOAD_TOO_LARGE") {
            respond(res, 413, { error: "Payload too large" })
          } else {
            respond(res, 500, { error: "Internal server error" })
          }
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

  getSecret(): string {
    return this.secret
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
    if (!pending) return

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
    // Health endpoint is unauthenticated
    if (req.method === "GET" && req.url === "/health") {
      return this.handleHealth(res)
    }

    // Validate Bearer token on all other endpoints (timing-safe comparison)
    const authHeader = req.headers.authorization
    const expected = `Bearer ${this.secret}`
    if (
      !authHeader ||
      authHeader.length !== expected.length ||
      !timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
    ) {
      respond(res, 401, { error: "Unauthorized" })
      return
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

    if (!body.callId || !body.toolName) {
      respond(res, 400, {
        status: "error",
        error: "Missing required fields: callId and toolName",
        code: "INVALID_REQUEST",
      })
      return
    }

    const { callId, toolName, args = {} } = body

    // Reject if too many pending calls (Fix 5: prevent resource exhaustion)
    if (this.pendingCalls.size >= MAX_PENDING_CALLS) {
      respond(res, 503, {
        status: "error",
        error: "Too many pending tool calls",
        code: "TOO_MANY_PENDING",
      })
      return
    }

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

    const pendingCall: PendingToolCall = { callId, toolName, args }
    this.laneRouter.route(pendingCall)

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

export function createIPCServer(options: IPCServerOptions = {}): IPCServer {
  return new IPCServerImpl(options)
}
