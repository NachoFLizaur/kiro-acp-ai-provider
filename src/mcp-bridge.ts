// ---------------------------------------------------------------------------
// MCP Bridge Server — Standalone script spawned by kiro-cli
// ---------------------------------------------------------------------------
//
// Usage:
//   bun /path/to/mcp-bridge.js --tools /path/to/tools.json [--cwd /path]
//
// This file is configured as an MCP server in the kiro agent config.
// It reads tool definitions from a JSON file and serves them via the MCP
// protocol over newline-delimited JSON-RPC on stdio.
//
// Communication:
//   stdin  ← JSON-RPC requests from kiro-cli (one JSON object per line)
//   stdout → JSON-RPC responses to kiro-cli (one JSON object per line)
//   stderr → Debug logging (does not interfere with the protocol)
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process"
import { createInterface } from "node:readline"
import * as fs from "node:fs"
import * as path from "node:path"
import * as http from "node:http"
import type { MCPToolDefinition, MCPToolsFile } from "./mcp-bridge-tools"
import type { ToolExecuteResponse } from "./ipc-server"

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

interface MCPToolResult {
  content: Array<{ type: "text"; text: string }>
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
// Tool name mapping: opencode tool names → bridge executor names
// ---------------------------------------------------------------------------
// When opencode passes dynamic tools (e.g. "read", "edit", "write"), we need
// to map them to the bridge's built-in executor names (e.g. "read_file",
// "edit_file", "write_file"). Tools that have no built-in executor are
// reported as unavailable.

const TOOL_NAME_TO_EXECUTOR: Record<string, string> = {
  // Direct matches (opencode name === executor name)
  bash: "bash",
  glob: "glob",
  grep: "grep",
  // opencode names → bridge executor names
  read: "read_file",
  edit: "edit_file",
  multiedit: "edit_file",
  write: "write_file",
  list: "list_directory",
  // Bridge-native names (from default tools)
  read_file: "read_file",
  write_file: "write_file",
  edit_file: "edit_file",
  list_directory: "list_directory",
}

/** Tools that are delegated to the host runtime via IPC. */
const DELEGATED_TOOLS = new Set([
  "task",
  "question",
  "todowrite",
  "skill",
])

/** Tools that are known but not executable anywhere. */
const UNAVAILABLE_TOOLS = new Set([
  "webfetch",
  "websearch",
  "web-research_multi_search",
  "web-research_fetch_pages",
  "todo",
])

// ---------------------------------------------------------------------------
// Built-in tool executors
// ---------------------------------------------------------------------------

const DEFAULT_TOOL_TIMEOUT_MS = 30_000

type ToolExecutor = (
  args: Record<string, unknown>,
  cwd: string,
) => Promise<string>

const EXECUTORS: Record<string, ToolExecutor> = {
  bash: async (args, cwd) => {
    const command = args.command as string
    if (!command) throw new Error("Missing required argument: command")

    const timeout = (args.timeout as number) ?? DEFAULT_TOOL_TIMEOUT_MS
    const workdir = (args.workdir as string) ?? cwd

    try {
      const result = execSync(command, {
        cwd: workdir,
        timeout,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024, // 10MB
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      })
      return result
    } catch (err: unknown) {
      const execErr = err as {
        stdout?: string
        stderr?: string
        status?: number
        signal?: string
        message?: string
      }
      const stdout = execErr.stdout ?? ""
      const stderr = execErr.stderr ?? ""
      const status = execErr.status ?? "unknown"
      const signal = execErr.signal ?? ""

      let output = ""
      if (stdout) output += stdout
      if (stderr) output += (output ? "\n" : "") + stderr
      if (!output) output = execErr.message ?? "Command failed"

      return `[exit code: ${status}${signal ? `, signal: ${signal}` : ""}]\n${output}`
    }
  },

  read_file: async (args, _cwd) => {
    const filePath = args.filePath as string
    if (!filePath) throw new Error("Missing required argument: filePath")

    const offset = Math.max(1, (args.offset as number) ?? 1)
    const limit = (args.limit as number) ?? 2000

    const content = fs.readFileSync(filePath, "utf-8")
    const lines = content.split("\n")

    // Apply offset (1-indexed) and limit
    const startIdx = offset - 1
    const slice = lines.slice(startIdx, startIdx + limit)

    // Prefix each line with its line number
    return slice.map((line, i) => `${startIdx + i + 1}: ${line}`).join("\n")
  },

  write_file: async (args, _cwd) => {
    const filePath = args.filePath as string
    const content = args.content as string
    if (!filePath) throw new Error("Missing required argument: filePath")
    if (content === undefined || content === null) {
      throw new Error("Missing required argument: content")
    }

    // Create parent directories if needed
    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true })

    fs.writeFileSync(filePath, content, "utf-8")
    return `Successfully wrote ${content.length} characters to ${filePath}`
  },

  edit_file: async (args, _cwd) => {
    const filePath = args.filePath as string
    const oldString = args.oldString as string
    const newString = args.newString as string
    const replaceAll = (args.replaceAll as boolean) ?? false

    if (!filePath) throw new Error("Missing required argument: filePath")
    if (oldString === undefined) throw new Error("Missing required argument: oldString")
    if (newString === undefined) throw new Error("Missing required argument: newString")

    let content = fs.readFileSync(filePath, "utf-8")

    if (!content.includes(oldString)) {
      throw new Error("oldString not found in file content")
    }

    if (replaceAll) {
      // Replace all occurrences safely (handles case where newString contains oldString)
      content = content.split(oldString).join(newString)
    } else {
      // Check for multiple matches
      const firstIdx = content.indexOf(oldString)
      const secondIdx = content.indexOf(oldString, firstIdx + 1)
      if (secondIdx !== -1) {
        throw new Error(
          "Found multiple matches for oldString. Provide more surrounding context to identify the correct match, or use replaceAll.",
        )
      }
      content = content.replace(oldString, newString)
    }

    fs.writeFileSync(filePath, content, "utf-8")
    return `Successfully edited ${filePath}`
  },

  glob: async (args, cwd) => {
    const pattern = args.pattern as string
    if (!pattern) throw new Error("Missing required argument: pattern")

    const searchPath = (args.path as string) ?? cwd

    // Try Bun.Glob first (Bun runtime only), then fall back to Node.js-compatible approach
    if (typeof globalThis.Bun !== "undefined") {
      try {
        const glob = new Bun.Glob(pattern)
        const matches: string[] = []
        for await (const match of glob.scan({ cwd: searchPath, absolute: true })) {
          matches.push(match)
        }
        if (matches.length === 0) {
          return "No files found matching pattern: " + pattern
        }
        return matches.join("\n")
      } catch {
        // Fall through to Node.js fallback
      }
    }

    // Node.js fallback: use fs.glob (Node 22+) or find command
    try {
      // Node.js 22+ has fs.glob
      const fsPromises = await import("node:fs/promises")
      if ("glob" in fsPromises) {
        const globFn = (fsPromises as any).glob as (pattern: string, options: { cwd: string }) => AsyncIterable<string>
        const matches: string[] = []
        for await (const match of globFn(pattern, { cwd: searchPath })) {
          matches.push(path.resolve(searchPath, match))
        }
        if (matches.length === 0) {
          return "No files found matching pattern: " + pattern
        }
        return matches.join("\n")
      }
    } catch {
      // Fall through to find command
    }

    // Final fallback: use find command with -path for glob-like patterns
    try {
      // Convert glob pattern to find-compatible: **/*.ts → -name "*.ts"
      const basename = pattern.split("/").pop() ?? pattern
      const result = execSync(
        `find . -type f -name ${JSON.stringify(basename)} 2>/dev/null | head -1000`,
        {
          cwd: searchPath,
          encoding: "utf-8",
          timeout: DEFAULT_TOOL_TIMEOUT_MS,
        },
      )
      if (!result.trim()) {
        return "No files found matching pattern: " + pattern
      }
      // Convert relative paths to absolute
      return result
        .trim()
        .split("\n")
        .map((p) => path.resolve(searchPath, p))
        .join("\n")
    } catch {
      return "No files found matching pattern: " + pattern
    }
  },

  grep: async (args, cwd) => {
    const pattern = args.pattern as string
    if (!pattern) throw new Error("Missing required argument: pattern")

    const searchPath = (args.path as string) ?? cwd
    const include = args.include as string | undefined

    // Use ripgrep if available, fall back to grep
    const grepIncludeFlag = include ? `--include="${include}"` : ""

    try {
      // Try ripgrep first
      const result = execSync(
        `rg --line-number --no-heading ${include ? `--glob "${include}"` : ""} ${JSON.stringify(pattern)} .`,
        {
          cwd: searchPath,
          encoding: "utf-8",
          timeout: DEFAULT_TOOL_TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024,
        },
      )
      return result.trim() || "No matches found"
    } catch {
      // Fall back to grep
      try {
        const result = execSync(
          `grep -rn ${grepIncludeFlag} ${JSON.stringify(pattern)} .`,
          {
            cwd: searchPath,
            encoding: "utf-8",
            timeout: DEFAULT_TOOL_TIMEOUT_MS,
            maxBuffer: 10 * 1024 * 1024,
          },
        )
        return result.trim() || "No matches found"
      } catch {
        return "No matches found"
      }
    }
  },

  list_directory: async (args, cwd) => {
    const dirPath = (args.path as string) ?? cwd
    if (!dirPath) throw new Error("Missing required argument: path")

    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    return entries
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .join("\n")
  },
}

// ---------------------------------------------------------------------------
// HTTP client for IPC delegation
// ---------------------------------------------------------------------------

function httpPost(url: string, body: unknown, timeoutMs: number = 310_000): Promise<ToolExecuteResponse> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const parsed = new URL(url)

    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let responseData = ""
        res.on("data", (chunk: Buffer) => {
          responseData += chunk.toString()
        })
        res.on("end", () => {
          try {
            resolve(JSON.parse(responseData) as ToolExecuteResponse)
          } catch {
            reject(new Error(`Invalid JSON response: ${responseData.slice(0, 200)}`))
          }
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
  private ipcHealthy = false
  private initialized = false

  constructor(tools: MCPToolDefinition[], cwd: string, toolsPath: string, ipcPort?: number) {
    this.tools = tools
    this.cwd = cwd
    this.toolsPath = toolsPath
    this.ipcPort = ipcPort
  }

  /** Handle an incoming JSON-RPC message and return a response (or null for notifications). */
  async handleMessage(msg: JsonRpcMessage): Promise<JsonRpcResponse | null> {
    // Notification (no id) — no response needed
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
          message: err instanceof Error ? err.message : String(err),
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
          version: "0.1.0",
        },
      },
    }
  }

  private handleToolsList(request: JsonRpcRequest): JsonRpcResponse {
    // Always re-read from file to pick up dynamic tool changes
    try {
      const raw = fs.readFileSync(this.toolsPath, "utf-8")
      const parsed = JSON.parse(raw) as MCPToolsFile
      if (Array.isArray(parsed.tools)) {
        this.tools = parsed.tools
      }
      if (parsed.ipcPort !== undefined) {
        this.ipcPort = parsed.ipcPort
      }
    } catch (err) {
      log("warn", `Failed to re-read tools file on tools/list: ${err}`)
      // Fall through — serve whatever tools we have cached
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

    log("info", `Tool call: ${toolName}`, JSON.stringify(toolArgs).slice(0, 200))

    // Check if tool is defined
    const toolDef = this.tools.find((t) => t.name === toolName)
    if (!toolDef) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32602, message: `Unknown tool: ${toolName}` },
      }
    }

    // Find executor via name mapping
    // First check if the tool should be delegated to the host runtime via IPC
    if (DELEGATED_TOOLS.has(toolName)) {
      return this.delegateToIPC(request.id, toolName, toolArgs)
    }

    // Then check if the tool is known-unavailable
    if (UNAVAILABLE_TOOLS.has(toolName)) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [
            {
              type: "text",
              text: `Tool "${toolName}" is not available in the MCP bridge. It is handled by the host agent.`,
            },
          ],
          isError: true,
        } satisfies MCPToolResult,
      }
    }

    // Map the tool name to an executor name
    const executorName = TOOL_NAME_TO_EXECUTOR[toolName] ?? toolName
    const executor = EXECUTORS[executorName]
    if (!executor) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [
            {
              type: "text",
              text: `Tool "${toolName}" is defined but has no built-in executor. Execution not supported.`,
            },
          ],
          isError: true,
        } satisfies MCPToolResult,
      }
    }

    try {
      const result = await executor(toolArgs, this.cwd)
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{ type: "text", text: result }],
        } satisfies MCPToolResult,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log("warn", `Tool ${toolName} failed:`, message)
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        } satisfies MCPToolResult,
      }
    }
  }

  /** Update the tool list (e.g. when the tools file changes). */
  updateTools(tools: MCPToolDefinition[], ipcPort?: number): void {
    this.tools = tools
    if (ipcPort !== undefined) {
      this.ipcPort = ipcPort
    }
    log("info", `Updated tool list: ${tools.length} tool(s)${ipcPort ? ` (ipcPort: ${ipcPort})` : ""}`)
    // Emit tools/list_changed notification
    sendNotification("notifications/tools/list_changed", {})
  }

  // -------------------------------------------------------------------------
  // IPC delegation
  // -------------------------------------------------------------------------

  /** Check if the IPC server is reachable. */
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

  /** Delegate a tool call to the host runtime via IPC HTTP. */
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
              text: `Tool "${toolName}" requires the opencode runtime but IPC is not configured. ` +
                `This tool cannot be executed in the standalone MCP bridge.`,
            },
          ],
          isError: true,
        } satisfies MCPToolResult,
      }
    }

    try {
      // Check health if we haven't confirmed it yet
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
                  text: `Tool "${toolName}" requires the opencode runtime but the IPC server is not responding. ` +
                    `The server may have crashed or not started yet.`,
                },
              ],
              isError: true,
            } satisfies MCPToolResult,
          }
        }
        this.ipcHealthy = true
      }

      const toolTimeout = 300_000 // 5 minutes for delegated tools
      const response = await httpPost(
        `http://127.0.0.1:${this.ipcPort}/tool/execute`,
        {
          toolName,
          toolCallId: `${requestId}`,
          args,
          timeout: toolTimeout,
        },
        toolTimeout + 10_000, // HTTP timeout is 10s longer
      )

      if (response.status === "success") {
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
      this.ipcHealthy = false // Reset health cache on failure
      const message = err instanceof Error ? err.message : String(err)
      log("error", `IPC delegation failed for ${toolName}:`, message)
      return {
        jsonrpc: "2.0",
        id: requestId,
        result: {
          content: [{ type: "text", text: `IPC delegation failed: ${message}` }],
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
      // Debounce rapid changes
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        try {
          const raw = fs.readFileSync(toolsPath, "utf-8")
          const parsed = JSON.parse(raw) as MCPToolsFile
          if (Array.isArray(parsed.tools)) {
            server.updateTools(parsed.tools, parsed.ipcPort)
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

  // Load initial tool definitions
  const toolsFile = loadToolsFile(toolsPath)
  const effectiveCwd = toolsFile.cwd ?? cwd

  const server = new MCPBridgeServer(toolsFile.tools, effectiveCwd, toolsPath, toolsFile.ipcPort)

  // Watch for tool file changes
  watchToolsFile(toolsPath, server)

  // Set up line-by-line reading from stdin
  const rl = createInterface({ input: process.stdin })

  rl.on("line", async (line: string) => {
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
  })

  // Exit cleanly when stdin closes
  rl.on("close", () => {
    log("info", "stdin closed, shutting down")
    process.exit(0)
  })

  // Handle process signals
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
