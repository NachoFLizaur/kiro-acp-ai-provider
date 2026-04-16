import { spawn, type ChildProcess } from "node:child_process"
import { createInterface, type Interface as ReadlineInterface } from "node:readline"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { generateAgentConfig, writeAgentConfig } from "./agent-config"
import { getDefaultTools } from "./mcp-bridge-tools"
import { createIPCServer, type IPCServer } from "./ipc-server"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Content block in a prompt or agent message. */
export interface ContentBlock {
  type: "text" | "image"
  text?: string
  /** Base64-encoded image data (when type === "image"). */
  data?: string
  mimeType?: string
}

/** A mode (agent) available in a session. */
export interface Mode {
  id: string
  name: string
  description?: string
  _meta?: { welcomeMessage?: string }
}

/** A model available in a session. */
export interface Model {
  modelId: string
  name: string
  description?: string
}

/** Session state returned by session/new and session/load. */
export interface ACPSession {
  sessionId: string
  modes: { currentModeId: string; availableModes: Mode[] }
  models: { currentModelId: string; availableModels: Model[] }
}

/** Streaming update from session/update notifications. */
export interface SessionUpdate {
  sessionUpdate: string
  [key: string]: unknown
}

/** Permission request from the server. */
export interface PermissionRequest {
  toolCall: {
    toolCallId: string
    name: string
    rawInput?: Record<string, unknown>
  }
  options: Array<{ id: string; label: string }>
}

/** Decision returned for a permission request. */
export interface PermissionDecision {
  outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" }
}

/** Result of initialize handshake. */
export interface InitializeResult {
  agentInfo: { name: string; version: string }
  agentCapabilities: Record<string, unknown>
}

/** Result of a command execution. */
export interface CommandResult {
  success: boolean
  message: string
  data?: Record<string, unknown>
}

/** Cached metadata for a session. */
export interface SessionMetadata {
  sessionId: string
  contextUsagePercentage?: number
  meteringUsage?: Array<{ unit: string; unitPlural: string; value: number }>
  turnDurationMs?: number
}

/** Options for creating an ACP client. */
export interface ACPClientOptions {
  /** Working directory for kiro-cli. */
  cwd: string
  /** Custom agent name passed via --agent flag (e.g. "opencode"). */
  agent?: string
  /** Pass --trust-all-tools to kiro-cli. */
  trustAllTools?: boolean
  /** Extra environment variables for the subprocess. */
  env?: Record<string, string>
  /** Custom system prompt for the agent config. Overrides the default prompt. */
  agentPrompt?: string
  /** Custom permission handler. Default: auto-approve with "allow_always". */
  onPermission?: (request: PermissionRequest) => PermissionDecision
  /** Called for every session/update notification. */
  onUpdate?: (sessionId: string, update: SessionUpdate) => void
  /** Called for every extension notification. */
  onExtension?: (method: string, params: Record<string, unknown>) => void
  /** Client info sent during initialize. */
  clientInfo?: { name: string; version: string; title?: string }
}

/** Options for sending a prompt. */
export interface PromptOptions {
  sessionId: string
  prompt: ContentBlock[]
  /** Called for each session/update notification scoped to this session. */
  onUpdate: (update: SessionUpdate) => void
  /** Abort signal — triggers session/cancel on abort. */
  signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// JSON-RPC types (internal)
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: number
  method: string
  params?: unknown
}

interface JsonRpcNotification {
  jsonrpc: "2.0"
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** A server-initiated request (has both id and method). */
interface JsonRpcServerRequest {
  jsonrpc: "2.0"
  id: number
  method: string
  params?: unknown
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ACPError extends Error {
  readonly name = "ACPError" as const
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message)
  }
}

export class ACPConnectionError extends Error {
  readonly name = "ACPConnectionError" as const
  constructor(message: string) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Pending request tracker
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  method: string
  timer: ReturnType<typeof setTimeout>
}

// ---------------------------------------------------------------------------
// ACPClient
// ---------------------------------------------------------------------------

const DEFAULT_REQUEST_TIMEOUT_MS = 300_000 // 5 minutes (prompts can be long)
const INITIALIZE_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 10_000

export class ACPClient {
  private readonly options: ACPClientOptions
  private process: ChildProcess | null = null
  private readline: ReadlineInterface | null = null
  private nextId = 0
  private readonly pending = new Map<number, PendingRequest>()
  private readonly metadata = new Map<string, SessionMetadata>()
  private readonly promptCallbacks = new Map<string, (update: SessionUpdate) => void>()
  private running = false
  private stderrBuffer = ""
  private toolsFilePath: string | null = null
  private ipcServer: IPCServer | null = null
  private ipcPort: number | null = null

  constructor(options: ACPClientOptions) {
    this.options = options
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Spawn kiro-cli acp and perform the initialize handshake. */
  async start(): Promise<InitializeResult> {
    if (this.running) throw new ACPConnectionError("Client is already running")

    // Start IPC server for tool call synchronization.
    // This must happen BEFORE setupAgentConfig so we have the port number
    // to write into the tools file.
    this.ipcServer = createIPCServer()
    this.ipcPort = await this.ipcServer.start()

    // Generate agent config before spawning kiro-cli so it can find the
    // .kiro/agents/<agent>.json file with MCP bridge configuration.
    if (this.options.agent) {
      this.setupAgentConfig()
    }

    const args = ["acp"]
    if (this.options.agent) args.push("--agent", this.options.agent)
    if (this.options.trustAllTools) args.push("--trust-all-tools")

    this.process = spawn("kiro-cli", args, {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.options.env },
    })

    this.running = true

    // Capture stderr for diagnostics
    this.process.stderr?.on("data", (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString()
      // Keep only last 4KB
      if (this.stderrBuffer.length > 4096) {
        this.stderrBuffer = this.stderrBuffer.slice(-4096)
      }
    })

    // Handle unexpected exit.
    // IMPORTANT: We must wait for readline to finish processing all buffered
    // lines before rejecting pending requests. The process can write a valid
    // response to stdout and then exit — if we reject immediately on "exit",
    // we race against readline's async line delivery and may reject a request
    // whose response is still in the readline buffer.
    this.process.on("exit", (code, signal) => {
      this.running = false

      const rejectPending = () => {
        for (const [id, pending] of this.pending) {
          pending.reject(
            new ACPConnectionError(
              `Process exited (code=${code}, signal=${signal}) while waiting for ${pending.method}`,
            ),
          )
          clearTimeout(pending.timer)
          this.pending.delete(id)
        }
      }

      // If readline is active, wait for it to close (all buffered lines processed)
      if (this.readline) {
        this.readline.once("close", rejectPending)
      } else {
        rejectPending()
      }
    })

    this.process.on("error", (err) => {
      this.running = false
      for (const [id, pending] of this.pending) {
        pending.reject(new ACPConnectionError(`Process error: ${err.message}`))
        clearTimeout(pending.timer)
        this.pending.delete(id)
      }
    })

    // Set up line-by-line reading from stdout
    this.readline = createInterface({ input: this.process.stdout! })
    this.readline.on("line", (line) => this.handleLine(line))

    // Perform initialize handshake
    const clientInfo = this.options.clientInfo ?? {
      name: "kiro-acp-ai-provider",
      version: "0.1.0",
      title: "Kiro ACP AI Provider",
    }

    const result = await this.sendRequest(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo,
      },
      INITIALIZE_TIMEOUT_MS,
    )

    return result as InitializeResult
  }

  /** Gracefully stop the kiro-cli process. */
  async stop(): Promise<void> {
    if (!this.running || !this.process) return

    this.running = false

    // Close stdin to signal EOF
    this.process.stdin?.end()

    // Wait for process to exit, with timeout.
    // The "exit" handler from start() will fire and reject pending requests,
    // so we just need to wait for the process to terminate.
    const proc = this.process
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill("SIGTERM")
        resolve()
      }, STOP_TIMEOUT_MS)

      proc.once("exit", () => {
        clearTimeout(timer)
        resolve()
      })
    })

    this.readline?.close()
    this.readline = null
    this.process = null

    // Clean up any remaining pending requests (in case exit handler didn't fire)
    for (const [id, pending] of this.pending) {
      pending.reject(new ACPConnectionError("Client stopped"))
      clearTimeout(pending.timer)
    }
    this.pending.clear()
    this.metadata.clear()
    this.promptCallbacks.clear()

    // Stop IPC server
    if (this.ipcServer) {
      await this.ipcServer.stop()
      this.ipcServer = null
      this.ipcPort = null
    }
  }

  // -------------------------------------------------------------------------
  // Session management
  // -------------------------------------------------------------------------

  /** Create a new session. */
  async createSession(): Promise<ACPSession> {
    const result = await this.sendRequest("session/new", {
      cwd: this.options.cwd,
      // mcpServers is required by the ACP protocol. We pass an empty array
      // because MCP servers are configured via the agent config file
      // (.kiro/agents/<name>.json), not per-session.
      mcpServers: [],
    })
    return result as ACPSession
  }

  /** Load an existing session by ID. */
  async loadSession(sessionId: string): Promise<ACPSession> {
    const result = await this.sendRequest("session/load", {
      sessionId,
      cwd: this.options.cwd,
      // mcpServers is required by the ACP protocol.
      mcpServers: [],
    })
    return result as ACPSession
  }

  // -------------------------------------------------------------------------
  // Prompting
  // -------------------------------------------------------------------------

  /** Send a prompt and stream updates. Resolves when the turn completes. */
  async prompt(options: PromptOptions): Promise<{ stopReason: string }> {
    const { sessionId, prompt, onUpdate, signal } = options

    // Register the per-prompt callback
    this.promptCallbacks.set(sessionId, onUpdate)

    // Handle abort signal
    let abortHandler: (() => void) | undefined
    if (signal) {
      abortHandler = () => {
        this.sendNotification("session/cancel", { sessionId })
      }
      if (signal.aborted) {
        this.promptCallbacks.delete(sessionId)
        throw new ACPError("Prompt aborted before sending", -1)
      }
      signal.addEventListener("abort", abortHandler, { once: true })
    }

    try {
      const result = await this.sendRequest(
        "session/prompt",
        { sessionId, prompt },
        DEFAULT_REQUEST_TIMEOUT_MS,
      )
      return result as { stopReason: string }
    } finally {
      this.promptCallbacks.delete(sessionId)
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Model & mode switching
  // -------------------------------------------------------------------------

  /** Switch the model for a session via kiro.dev/commands/execute. */
  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.executeCommand(sessionId, "model", { value: modelId })
  }

  /** Switch the agent mode for a session. */
  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.sendRequest("session/set_mode", { sessionId, modeId })
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /** Execute a kiro slash command. */
  async executeCommand(
    sessionId: string,
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<CommandResult> {
    const result = await this.sendRequest("_kiro.dev/commands/execute", {
      sessionId,
      command: { command, args },
    })
    return result as CommandResult
  }

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  /** Get cached metadata for a session (populated by _kiro.dev/metadata notifications). */
  getMetadata(sessionId: string): SessionMetadata | undefined {
    return this.metadata.get(sessionId)
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  /** Check if the kiro-cli process is running. */
  isRunning(): boolean {
    return this.running
  }

  /** Get recent stderr output for diagnostics. */
  getStderr(): string {
    return this.stderrBuffer
  }

  /** Get the working directory configured for this client. */
  getCwd(): string {
    return this.options.cwd
  }

  /** Get the path to the tools JSON file used by the MCP bridge. */
  getToolsFilePath(): string | null {
    return this.toolsFilePath
  }

  /**
   * Get or create the tools file path deterministically.
   *
   * This allows the adapter to write tool definitions BEFORE `start()` is
   * called (and before `setupAgentConfig()` runs), so that when kiro-cli
   * spawns the MCP bridge and queries `tools/list`, the full tool set is
   * already on disk.
   *
   * The path is stable across restarts for the same project directory:
   * `{tmpdir}/kiro-acp/tools-{cwdHash}.json`. This avoids the stale-path
   * problem that occurred when using `process.pid` — on restart, the PID
   * changes but the agent config still referenced the old file. Using a
   * hash of `cwd` ensures the same project always maps to the same file,
   * while different projects running simultaneously get separate files.
   */
  getOrCreateToolsFilePath(): string {
    if (this.toolsFilePath) return this.toolsFilePath

    const toolsDir = join(tmpdir(), "kiro-acp")
    mkdirSync(toolsDir, { recursive: true })
    const cwdHash = createHash("md5").update(this.options.cwd).digest("hex").slice(0, 8)
    this.toolsFilePath = join(toolsDir, `tools-${cwdHash}.json`)
    return this.toolsFilePath
  }

  /** Get the IPC server port (if running). */
  getIpcPort(): number | null {
    return this.ipcPort
  }

  /** Get the IPC server instance (for direct in-process communication). */
  getIPCServer(): IPCServer | null {
    return this.ipcServer
  }

  /**
   * Replace the prompt callback for a session.
   * Used by the adapter during resumption to re-wire update handling.
   */
  setPromptCallback(sessionId: string, callback: (update: SessionUpdate) => void): void {
    this.promptCallbacks.set(sessionId, callback)
  }

  // -------------------------------------------------------------------------
  // Internal: Agent config setup
  // -------------------------------------------------------------------------

  /**
   * Generate and write the agent config file so kiro-cli can discover the
   * MCP bridge server and tool definitions.
   *
   * Writes:
   * 1. A tools JSON file to a temp directory
   * 2. The agent config to `{cwd}/.kiro/agents/{agent}.json`
   */
  private setupAgentConfig(): void {
    // Resolve the MCP bridge script path — it's a sibling file in the same dist/ directory.
    // Handle both ESM (import.meta.url) and CJS (__dirname) module systems.
    let currentDir: string
    if (typeof import.meta?.url === "string" && import.meta.url) {
      currentDir = dirname(fileURLToPath(import.meta.url))
    } else if (typeof __dirname === "string") {
      currentDir = __dirname
    } else {
      throw new ACPConnectionError(
        "Cannot resolve MCP bridge path: neither import.meta.url nor __dirname available",
      )
    }

    // Resolve the bridge path, handling Bun's virtual filesystem.
    // When this package is compiled into a Bun binary (bun build --compile),
    // import.meta.url resolves to a virtual path like /$bunfs/root/... which
    // doesn't exist on the real filesystem. The Bun process can read from these
    // virtual paths, but the spawned `node` process (kiro-cli) cannot.
    // In that case, we copy the bridge script to a real temp directory.
    const bridgePath = this.resolveBridgePath(currentDir)

    // Get or create the tools file path. If the adapter already wrote tools
    // (via writeToolsFile before start), this reuses that path and we skip
    // overwriting with defaults. Otherwise, write default tools so the MCP
    // bridge has something to serve on first `tools/list` query.
    const toolsFile = this.getOrCreateToolsFilePath()
    try {
      // Check if the file already exists (adapter wrote tools before start)
      const existing = readFileSync(toolsFile, "utf-8")
      const parsed = JSON.parse(existing) as { tools?: unknown[]; ipcPort?: number }
      if (!Array.isArray(parsed.tools) || parsed.tools.length === 0) {
        throw new Error("empty or invalid tools file")
      }
      // File exists with tools — don't overwrite with defaults.
      // But DO ensure ipcPort is present. The adapter may have written tools
      // before start() was called (when ipcPort was still null). Now that the
      // IPC server is running, inject the port so the MCP bridge can delegate.
      if (this.ipcPort != null && parsed.ipcPort !== this.ipcPort) {
        parsed.ipcPort = this.ipcPort
        writeFileSync(toolsFile, JSON.stringify(parsed, null, 2))
      }
    } catch {
      // File doesn't exist or is invalid — write defaults
      const toolsData = {
        tools: getDefaultTools(),
        cwd: this.options.cwd,
        ...(this.ipcPort != null ? { ipcPort: this.ipcPort } : {}),
      }
      writeFileSync(toolsFile, JSON.stringify(toolsData, null, 2))
    }

    // Generate and write the agent config
    const config = generateAgentConfig({
      name: this.options.agent,
      mcpBridgePath: bridgePath,
      toolsFilePath: toolsFile,
      cwd: this.options.cwd,
      prompt: this.options.agentPrompt,
    })

    writeAgentConfig(this.options.cwd, this.options.agent!, config)
  }

  /**
   * Resolve the MCP bridge script to a real filesystem path.
   *
   * When running inside a Bun-compiled binary, `import.meta.url` points to a
   * virtual path (e.g. `/$bunfs/root/...`) that only the Bun process can read.
   * Since kiro-cli spawns the bridge with `node`, we need the script at a real
   * path. This method detects virtual paths and copies the bridge script to a
   * temp directory.
   */
  private resolveBridgePath(currentDir: string): string {
    const candidate = join(currentDir, "mcp-bridge.js")
    const isVirtualPath = candidate.includes("$bunfs")

    // If the file exists on the real filesystem and isn't a virtual path, use it directly.
    if (!isVirtualPath && existsSync(candidate)) {
      return candidate
    }

    // Virtual path or file not found on real filesystem — copy to temp.
    // Bun can read from its virtual filesystem, so readFileSync works here
    // even though `node` wouldn't be able to access the path.
    const tmpBridge = join(tmpdir(), "kiro-acp", "mcp-bridge.js")
    mkdirSync(dirname(tmpBridge), { recursive: true })

    try {
      const content = readFileSync(candidate, "utf-8")
      writeFileSync(tmpBridge, content, "utf-8")
      return tmpBridge
    } catch (err) {
      throw new ACPConnectionError(
        `Could not resolve mcp-bridge.js: source path "${candidate}" is not readable. ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // -------------------------------------------------------------------------
  // Internal: JSON-RPC transport
  // -------------------------------------------------------------------------

  private sendRequest(
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.running || !this.process?.stdin?.writable) {
        reject(new ACPConnectionError("Client is not running"))
        return
      }

      const id = this.nextId++
      const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params }

      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new ACPError(`Request timed out after ${timeoutMs}ms: ${method}`, -1))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, method, timer })

      const line = JSON.stringify(request) + "\n"
      this.process!.stdin!.write(line)
    })
  }

  private sendNotification(method: string, params: unknown): void {
    if (!this.running || !this.process?.stdin?.writable) return

    const notification: JsonRpcNotification = { jsonrpc: "2.0", method, params }
    const line = JSON.stringify(notification) + "\n"
    this.process!.stdin!.write(line)
  }

  private sendResponse(id: number, result: unknown): void {
    if (!this.running || !this.process?.stdin?.writable) return

    const response = { jsonrpc: "2.0", id, result }
    const line = JSON.stringify(response) + "\n"
    this.process!.stdin!.write(line)
  }

  // -------------------------------------------------------------------------
  // Internal: message dispatch
  // -------------------------------------------------------------------------

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return

    let msg: JsonRpcMessage
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage
    } catch {
      // Non-JSON output from kiro-cli (e.g. log lines) — ignore
      return
    }

    // Classify the message:
    // 1. Response: has "id" and no "method" → resolve pending request
    // 2. Server request: has "id" AND "method" → handle (e.g. permission)
    // 3. Notification: has "method" but no "id" → dispatch

    const hasId = "id" in msg && msg.id !== undefined
    const hasMethod = "method" in msg && typeof (msg as { method?: unknown }).method === "string"

    if (hasId && !hasMethod) {
      this.handleResponse(msg as JsonRpcResponse)
    } else if (hasId && hasMethod) {
      this.handleServerRequest(msg as JsonRpcServerRequest)
    } else if (hasMethod) {
      this.handleNotification(msg as JsonRpcNotification)
    }
  }

  private handleResponse(msg: JsonRpcResponse): void {
    const pending = this.pending.get(msg.id)
    if (!pending) return

    clearTimeout(pending.timer)
    this.pending.delete(msg.id)

    if (msg.error) {
      pending.reject(new ACPError(msg.error.message, msg.error.code, msg.error.data))
    } else {
      pending.resolve(msg.result)
    }
  }

  private handleServerRequest(msg: JsonRpcServerRequest): void {
    switch (msg.method) {
      case "session/request_permission":
        this.handlePermissionRequest(msg.id, msg.params as PermissionRequest)
        break
      default:
        // Unknown server request — respond with method not found
        this.sendResponse(msg.id, null)
        break
    }
  }

  private handlePermissionRequest(id: number, request: PermissionRequest): void {
    if (this.options.onPermission) {
      const decision = this.options.onPermission(request)
      this.sendResponse(id, decision)
    } else {
      // Default: auto-approve with "allow_always" if available, else "allow_once"
      const alwaysOption = request.options.find((o) => o.id === "allow_always")
      const onceOption = request.options.find((o) => o.id === "allow_once")
      const optionId = alwaysOption?.id ?? onceOption?.id ?? request.options[0]?.id ?? "allow_once"

      this.sendResponse(id, {
        outcome: { outcome: "selected", optionId },
      })
    }
  }

  private handleNotification(msg: JsonRpcNotification): void {
    const params = (msg.params ?? {}) as Record<string, unknown>

    switch (msg.method) {
      case "session/update":
        this.handleSessionUpdate(params)
        break

      case "_kiro.dev/metadata":
        this.handleMetadata(params)
        break

      case "_kiro.dev/session/update":
        // Kiro-specific session updates (e.g. tool_call_chunk)
        this.handleSessionUpdate(params)
        break

      default:
        // Forward all extension notifications to the optional handler
        this.options.onExtension?.(msg.method, params)
        break
    }
  }

  private handleSessionUpdate(params: Record<string, unknown>): void {
    const sessionId = params.sessionId as string | undefined
    const update = params.update as SessionUpdate | undefined

    if (!update) return

    // Deliver to per-prompt callback if registered
    if (sessionId) {
      const callback = this.promptCallbacks.get(sessionId)
      callback?.(update)
    }

    // Deliver to global onUpdate handler
    if (sessionId) {
      this.options.onUpdate?.(sessionId, update)
    }
  }

  private handleMetadata(params: Record<string, unknown>): void {
    const sessionId = params.sessionId as string | undefined
    if (!sessionId) return

    this.metadata.set(sessionId, {
      sessionId,
      contextUsagePercentage: params.contextUsagePercentage as number | undefined,
      meteringUsage: params.meteringUsage as SessionMetadata["meteringUsage"],
      turnDurationMs: params.turnDurationMs as number | undefined,
    })
  }
}
