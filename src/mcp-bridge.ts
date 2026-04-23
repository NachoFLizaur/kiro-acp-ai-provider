// ---------------------------------------------------------------------------
// MCP Bridge Server — Standalone script spawned by kiro-cli
// ---------------------------------------------------------------------------
//
// Usage: node mcp-bridge.js --tools /path/to/tools.json [--cwd /path]
//
// Reads tool definitions from a JSON file and serves them via MCP protocol
// over newline-delimited JSON-RPC on stdio. All tool calls are delegated
// to the harness via IPC — the bridge does NOT execute tools locally.
// ---------------------------------------------------------------------------

import { createInterface } from "node:readline"
import * as fs from "node:fs"
import * as http from "node:http"
import { randomBytes } from "node:crypto"
import type { MCPToolDefinition, MCPToolsFile } from "./mcp-bridge-tools"
import type { ToolExecuteResponse } from "./ipc-server"

// Per-process unique prefix to avoid callId collisions across bridge processes
const BRIDGE_ID = randomBytes(4).toString("hex")

// Monotonic counter — kiro-cli's request IDs reset per session so they're
// unsafe as callIds for concurrent sessions
let globalCallCounter = 0

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: number | string
  method: string
  params?: unknown
}

interface JsonRpcNotification {
  jsonrpc: "2.0"
  method: string
  params?: unknown
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

// ---------------------------------------------------------------------------
// MCP protocol types
// ---------------------------------------------------------------------------

interface MCPContentBlock {
  type: "text" | "image"
  text?: string      // for type: "text"
  data?: string      // base64 for type: "image"
  mimeType?: string  // for type: "image"
}

interface MCPToolResult {
  content: MCPContentBlock[]
  isError?: boolean
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): { toolsPath: string; cwd: string } {
  const args = process.argv.slice(2)
  let toolsPath = ""
  let cwd = process.cwd()

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--tools":
        toolsPath = args[++i] ?? ""
        break
      case "--cwd":
        cwd = args[++i] ?? process.cwd()
        break
    }
  }

  if (!toolsPath) {
    log("error", "Missing required --tools argument")
    process.exit(1)
  }

  return { toolsPath, cwd }
}

// ---------------------------------------------------------------------------
// Logging (stderr only)
// ---------------------------------------------------------------------------

function log(level: "debug" | "info" | "warn" | "error", ...args: unknown[]): void {
  const prefix = `[mcp-bridge][${level}]`
  process.stderr.write(`${prefix} ${args.map(String).join(" ")}\n`)
}

// ---------------------------------------------------------------------------
// Tool file loading
// ---------------------------------------------------------------------------

function loadToolsFile(toolsPath: string): MCPToolsFile {
  try {
    const raw = fs.readFileSync(toolsPath, "utf-8")
    const parsed = JSON.parse(raw) as MCPToolsFile
    if (!Array.isArray(parsed.tools)) {
      throw new Error("tools field must be an array")
    }
    log("info", `Loaded ${parsed.tools.length} tool(s) from ${toolsPath}`)
    return parsed
  } catch (err) {
    log("error", `Failed to load tools file: ${err}`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// HTTP client for IPC delegation
// ---------------------------------------------------------------------------

function httpPost(url: string, body: unknown, timeoutMs: number = 310_000, authToken?: string): Promise<ToolExecuteResponse> {
  const MAX_RESPONSE_SIZE = 10 * 1024 * 1024 // 10 MB
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const parsed = new URL(url)

    const headers: Record<string, string | number> = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data),
    }
    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`
    }

    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let settled = false
        const chunks: Buffer[] = []
        let size = 0
        res.on("data", (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_RESPONSE_SIZE) {
            if (!settled) { settled = true; reject(new Error("Response too large")) }
            res.destroy()
            return
          }
          chunks.push(chunk)
        })
        res.on("end", () => {
          if (settled) return
          settled = true
          try {
            const responseData = Buffer.concat(chunks).toString()
            resolve(JSON.parse(responseData) as ToolExecuteResponse)
          } catch {
            reject(new Error("Invalid JSON response"))
          }
        })
        res.on("error", (err) => {
          if (!settled) { settled = true; reject(err) }
        })
      },
    )

    req.on("error", reject)
    req.on("timeout", () => {
      req.destroy()
      reject(new Error("HTTP request timed out"))
    })

    req.write(data)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

class MCPBridgeServer {
  private tools: MCPToolDefinition[]
  private readonly cwd: string
  private readonly toolsPath: string
  private ipcPort: number | undefined
  private ipcSecret: string | undefined
  private ipcHealthy = false
  private initialized = false

  constructor(tools: MCPToolDefinition[], cwd: string, toolsPath: string, ipcPort?: number, ipcSecret?: string) {
    this.tools = tools
    this.cwd = cwd
    this.toolsPath = toolsPath
    this.ipcPort = ipcPort
    this.ipcSecret = ipcSecret
  }

  async handleMessage(msg: JsonRpcMessage): Promise<JsonRpcResponse | null> {
    if (!("id" in msg) || msg.id === undefined) {
      this.handleNotification(msg as JsonRpcNotification)
      return null
    }

    const request = msg as JsonRpcRequest

    try {
      switch (request.method) {
        case "initialize":
          return this.handleInitialize(request)
        case "tools/list":
          return this.handleToolsList(request)
        case "tools/call":
          return await this.handleToolsCall(request)
        case "ping":
          return { jsonrpc: "2.0", id: request.id, result: {} }
        default:
          return {
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: -32601,
              message: `Method not found: ${request.method}`,
            },
          }
      }
    } catch (err) {
      log("error", `Error handling ${request.method}:`, err)
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32603,
          message: "Internal error",
        },
      }
    }
  }

  private handleNotification(msg: JsonRpcNotification): void {
    switch (msg.method) {
      case "notifications/initialized":
        log("info", "Client sent initialized notification")
        break
      case "notifications/cancelled":
        log("info", "Client cancelled request:", JSON.stringify(msg.params))
        break
      default:
        log("debug", `Ignoring notification: ${msg.method}`)
    }
  }

  private handleInitialize(request: JsonRpcRequest): JsonRpcResponse {
    this.initialized = true
    log("info", "Initialize request received")

    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: { listChanged: true },
        },
        serverInfo: {
          name: "mcp-bridge",
          version: "1.0.0",
        },
      },
    }
  }

  private handleToolsList(request: JsonRpcRequest): JsonRpcResponse {
    // Re-read from file to pick up dynamic tool changes
    try {
      const raw = fs.readFileSync(this.toolsPath, "utf-8")
      const parsed = JSON.parse(raw) as MCPToolsFile
      if (Array.isArray(parsed.tools)) {
        this.tools = parsed.tools
      }
      if (parsed.ipcPort !== undefined) {
        this.ipcPort = parsed.ipcPort
      }
      if (parsed.ipcSecret !== undefined) {
        this.ipcSecret = parsed.ipcSecret
      }
    } catch (err) {
      log("warn", `Failed to re-read tools file on tools/list: ${err}`)
    }

    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: this.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      },
    }
  }

  private async handleToolsCall(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = request.params as { name: string; arguments?: Record<string, unknown> } | undefined
    if (!params?.name) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32602, message: "Missing tool name in params" },
      }
    }

    const toolName = params.name
    const toolArgs = params.arguments ?? {}

    log("info", `Tool call: ${toolName}`, `args: [${Object.keys(toolArgs).join(", ")}]`)

    const toolDef = this.tools.find((t) => t.name === toolName)
    if (!toolDef) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32602, message: `Unknown tool: ${toolName}` },
      }
    }

    return this.delegateToIPC(request.id, toolName, toolArgs)
  }

  updateTools(tools: MCPToolDefinition[], ipcPort?: number, ipcSecret?: string): void {
    this.tools = tools
    if (ipcPort !== undefined) {
      this.ipcPort = ipcPort
    }
    if (ipcSecret !== undefined) {
      this.ipcSecret = ipcSecret
    }
    log("info", `Updated tool list: ${tools.length} tool(s)${ipcPort ? ` (ipcPort: ${ipcPort})` : ""}`)
    sendNotification("notifications/tools/list_changed", {})
  }

  // -------------------------------------------------------------------------
  // IPC delegation
  // -------------------------------------------------------------------------

  private async checkHealth(): Promise<boolean> {
    if (!this.ipcPort) return false

    return new Promise<boolean>((resolve) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.ipcPort,
          path: "/health",
          method: "GET",
          timeout: 5_000,
        },
        (res) => {
          let data = ""
          res.on("data", (chunk: Buffer) => { data += chunk.toString() })
          res.on("end", () => {
            try {
              const parsed = JSON.parse(data) as { status?: string }
              resolve(parsed.status === "ok")
            } catch {
              resolve(false)
            }
          })
        },
      )
      req.on("error", () => resolve(false))
      req.on("timeout", () => {
        req.destroy()
        resolve(false)
      })
      req.end()
    })
  }

  private async delegateToIPC(
    requestId: number | string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    if (!this.ipcPort) {
      return {
        jsonrpc: "2.0",
        id: requestId,
        result: {
          content: [
            {
              type: "text",
              text: `Tool "${toolName}" cannot be executed: IPC not configured.`,
            },
          ],
          isError: true,
        } satisfies MCPToolResult,
      }
    }

    try {
      if (!this.ipcHealthy) {
        const healthy = await this.checkHealth()
        if (!healthy) {
          return {
            jsonrpc: "2.0",
            id: requestId,
            result: {
              content: [
                {
                  type: "text",
                  text: `Tool "${toolName}" requires the harness runtime but the IPC server is not responding. ` +
                    `The server may have crashed or not started yet.`,
                },
              ],
              isError: true,
            } satisfies MCPToolResult,
          }
        }
        this.ipcHealthy = true
      }

      // Blocks until the harness executes the tool
      const response = await httpPost(
        `http://127.0.0.1:${this.ipcPort}/tool/pending`,
        { callId: `${BRIDGE_ID}-${++globalCallCounter}`, toolName, args },
        310_000,
        this.ipcSecret,
      )

      if (response.status === "success") {
        // If structured content is available (may include images), use it
        if (response.content && response.content.length > 0) {
          const mcpContent: MCPContentBlock[] = response.content.map((block) => {
            if (block.type === "image" && block.data && block.mimeType) {
              return { type: "image" as const, data: block.data, mimeType: block.mimeType }
            }
            return { type: "text" as const, text: block.text ?? "" }
          })

          return {
            jsonrpc: "2.0",
            id: requestId,
            result: { content: mcpContent } satisfies MCPToolResult,
          }
        }

        // Fallback: text-only result (backward compatible)
        return {
          jsonrpc: "2.0",
          id: requestId,
          result: {
            content: [{ type: "text", text: response.result ?? "" }],
          } satisfies MCPToolResult,
        }
      } else {
        return {
          jsonrpc: "2.0",
          id: requestId,
          result: {
            content: [{ type: "text", text: `Error: ${response.error ?? "Unknown error"}` }],
            isError: true,
          } satisfies MCPToolResult,
        }
      }
    } catch (err) {
      this.ipcHealthy = false
      const message = err instanceof Error ? err.message : String(err)
      log("error", `IPC delegation failed for ${toolName}:`, message)
      return {
        jsonrpc: "2.0",
        id: requestId,
        result: {
          content: [{ type: "text", text: "Tool execution failed" }],
          isError: true,
        } satisfies MCPToolResult,
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Stdio transport
// ---------------------------------------------------------------------------

function sendResponse(response: JsonRpcResponse): void {
  const line = JSON.stringify(response) + "\n"
  process.stdout.write(line)
}

function sendNotification(method: string, params: unknown): void {
  const msg = { jsonrpc: "2.0", method, params }
  const line = JSON.stringify(msg) + "\n"
  process.stdout.write(line)
}

// ---------------------------------------------------------------------------
// File watcher for tool definitions
// ---------------------------------------------------------------------------

function watchToolsFile(toolsPath: string, server: MCPBridgeServer): void {
  try {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    fs.watch(toolsPath, () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        try {
          const raw = fs.readFileSync(toolsPath, "utf-8")
          const parsed = JSON.parse(raw) as MCPToolsFile
          if (Array.isArray(parsed.tools)) {
            server.updateTools(parsed.tools, parsed.ipcPort, parsed.ipcSecret)
          }
        } catch (err) {
          log("warn", `Failed to reload tools file: ${err}`)
        }
      }, 100)
    })

    log("info", `Watching tools file for changes: ${toolsPath}`)
  } catch (err) {
    log("warn", `Could not watch tools file: ${err}`)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { toolsPath, cwd } = parseArgs()

  log("info", `Starting MCP bridge server (cwd: ${cwd})`)
  log("info", `Tools file: ${toolsPath}`)

  const toolsFile = loadToolsFile(toolsPath)
  const effectiveCwd = toolsFile.cwd ?? cwd

  const server = new MCPBridgeServer(toolsFile.tools, effectiveCwd, toolsPath, toolsFile.ipcPort, toolsFile.ipcSecret)

  watchToolsFile(toolsPath, server)

  const rl = createInterface({ input: process.stdin })

  rl.on("line", async (line: string) => {
    try {
      const trimmed = line.trim()
      if (!trimmed) return

      let msg: JsonRpcMessage
      try {
        msg = JSON.parse(trimmed) as JsonRpcMessage
      } catch {
        log("warn", "Received non-JSON input:", trimmed.slice(0, 100))
        return
      }

      const response = await server.handleMessage(msg)
      if (response) {
        sendResponse(response)
      }
    } catch (err) {
      log("error", "Failed to handle message", String(err))
    }
  })

  rl.on("close", () => {
    log("info", "stdin closed, shutting down")
    process.exit(0)
  })

  process.on("SIGTERM", () => {
    log("info", "Received SIGTERM, shutting down")
    process.exit(0)
  })

  process.on("SIGINT", () => {
    log("info", "Received SIGINT, shutting down")
    process.exit(0)
  })

  log("info", "MCP bridge server ready")
}

main().catch((err) => {
  log("error", "Fatal error:", err)
  process.exit(1)
})
