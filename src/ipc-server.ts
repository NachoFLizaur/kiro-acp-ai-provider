// ---------------------------------------------------------------------------
// IPC Server — HTTP server for tool delegation from MCP bridge
// ---------------------------------------------------------------------------
//
// Runs in the opencode process (via kiro-acp-ai-provider library).
// The MCP bridge subprocess sends HTTP requests to delegate tool calls
// that require opencode's runtime (task, question, todowrite, skill).
//
// Uses Node.js `http` module for cross-runtime compatibility (Node + Bun).
// ---------------------------------------------------------------------------

import * as http from "node:http"
import type * as net from "node:net"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Request body for POST /tool/execute. */
export interface ToolExecuteRequest {
  toolName: string
  toolCallId: string
  args: Record<string, unknown>
  sessionId?: string
  timeout?: number
}

/** Response body for POST /tool/execute. */
export interface ToolExecuteResponse {
  status: "success" | "error"
  result?: string
  error?: string
  code?: string
}

/**
 * Callback that executes a tool in the host runtime (e.g. opencode).
 *
 * The executor receives the full request and an AbortSignal for cancellation.
 * It should return the tool's text result on success, or throw on failure.
 */
export type ToolExecutorFn = (
  request: ToolExecuteRequest,
  signal: AbortSignal,
) => Promise<string>

/** Options for creating an IPC server. */
export interface IPCServerOptions {
  /** The tool executor callback — bridges to the host runtime. */
  toolExecutor: ToolExecutorFn
  /** Hostname to bind to. Default: "127.0.0.1". */
  host?: string
}

/** Public interface for the IPC server. */
export interface IPCServer {
  /** Start the server. Returns the assigned port. */
  start(): Promise<number>
  /** Stop the server and abort all in-flight calls. */
  stop(): Promise<void>
  /** Get the port the server is listening on. */
  getPort(): number | null
  /** Get the number of in-flight tool calls. */
  getPendingCount(): number
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

class IPCServerImpl implements IPCServer {
  private server: http.Server | null = null
  private port: number | null = null
  private readonly pending = new Map<string, AbortController>()
  private readonly cancelled = new Set<string>()
  private readonly executor: ToolExecutorFn
  private readonly host: string
  private startTime: number = 0

  constructor(options: IPCServerOptions) {
    this.executor = options.toolExecutor
    this.host = options.host ?? "127.0.0.1"
  }

  async start(): Promise<number> {
    if (this.server) {
      throw new Error("IPC server is already running")
    }

    this.startTime = Date.now()
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        // Unexpected error in request handling — send 500
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
    // Abort all in-flight calls
    for (const [, ac] of this.pending) {
      ac.abort()
    }
    this.pending.clear()
    this.cancelled.clear()

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
    return this.pending.size
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
    if (req.method === "POST" && req.url === "/tool/execute") {
      return this.handleToolExecute(req, res)
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
      pendingCalls: this.pending.size,
    })
  }

  // -------------------------------------------------------------------------
  // POST /tool/execute
  // -------------------------------------------------------------------------

  private async handleToolExecute(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // Parse request body
    let body: ToolExecuteRequest
    try {
      const raw = await readBody(req)
      body = JSON.parse(raw) as ToolExecuteRequest
    } catch {
      respond(res, 400, {
        status: "error",
        error: "Invalid JSON in request body",
        code: "INVALID_REQUEST",
      } satisfies ToolExecuteResponse)
      return
    }

    // Validate required fields
    if (!body.toolName || !body.toolCallId) {
      respond(res, 400, {
        status: "error",
        error: "Missing required fields: toolName and toolCallId",
        code: "INVALID_REQUEST",
      } satisfies ToolExecuteResponse)
      return
    }

    const { toolCallId, timeout = 300_000 } = body

    // Create abort controller for this call
    const ac = new AbortController()
    this.pending.set(toolCallId, ac)

    // Set timeout
    const timer = setTimeout(() => ac.abort(), timeout)

    try {
      const result = await this.executor(body, ac.signal)
      respond(res, 200, {
        status: "success",
        result,
      } satisfies ToolExecuteResponse)
    } catch (err) {
      if (ac.signal.aborted) {
        // Determine if this was a timeout or explicit cancellation
        const wasCancelled = this.cancelled.has(toolCallId)
        respond(res, 200, {
          status: "error",
          error: wasCancelled
            ? "Tool execution was cancelled"
            : "Tool execution timed out",
          code: wasCancelled ? "TOOL_CANCELLED" : "TOOL_TIMEOUT",
        } satisfies ToolExecuteResponse)
      } else {
        respond(res, 200, {
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          code: "TOOL_EXECUTION_FAILED",
        } satisfies ToolExecuteResponse)
      }
    } finally {
      clearTimeout(timer)
      this.pending.delete(toolCallId)
      this.cancelled.delete(toolCallId)
    }
  }

  // -------------------------------------------------------------------------
  // POST /tool/cancel
  // -------------------------------------------------------------------------

  private async handleToolCancel(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: { toolCallId?: string }
    try {
      const raw = await readBody(req)
      body = JSON.parse(raw) as { toolCallId?: string }
    } catch {
      respond(res, 400, { error: "Invalid JSON in request body" })
      return
    }

    if (!body.toolCallId) {
      respond(res, 400, { error: "Missing required field: toolCallId" })
      return
    }

    const ac = this.pending.get(body.toolCallId)
    if (ac) {
      this.cancelled.add(body.toolCallId)
      ac.abort()
      // Note: we don't delete from pending here — the execute handler's
      // finally block will clean it up when the aborted promise settles.
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
export function createIPCServer(options: IPCServerOptions): IPCServer {
  return new IPCServerImpl(options)
}
