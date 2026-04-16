import { spawn, type ChildProcess } from "node:child_process"
import { createInterface, type Interface as ReadlineInterface } from "node:readline"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { generateAgentConfig, writeAgentConfig } from "./agent-config"
import { getDefaultTools } from "./mcp-bridge-tools"
import { createIPCServer, type IPCServer } from "./ipc-server"
import type { LaneRouter } from "./lane-router"

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

/** A tool reported as available by kiro-cli via `_kiro.dev/commands/available`. */
export interface AvailableTool {
  name: string
  source: string
  description?: string
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
  private availableTools: AvailableTool[] = []
  private toolsReadyListeners = new Set<(tools: AvailableTool[]) => void>()

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
      version: "1.0.0",
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
    this.toolsReadyListeners.clear()
    this.availableTools = []

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

  /** Get cached metadata for all sessions. */
  getAllMetadata(): SessionMetadata[] {
    return [...this.metadata.values()]
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

  /** Get the custom agent name (e.g. "opencode") if configured. */
  getAgentName(): string | undefined {
    return this.options.agent
  }

  /** Get the current list of tools that kiro-cli has available. */
  getAvailableTools(): AvailableTool[] {
    return [...this.availableTools]
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

  /** Get the lane router from the IPC server (for per-session tool call routing). */
  getLaneRouter(): LaneRouter | null {
    return this.ipcServer?.getLaneRouter() ?? null
  }

  /**
   * Replace the prompt callback for a session.
   * Used by the adapter during resumption to re-wire update handling.
   */
  setPromptCallback(sessionId: string, callback: (update: SessionUpdate) => void): void {
    this.promptCallbacks.set(sessionId, callback)
  }

  /**
   * Wait for kiro-cli to send a `_kiro.dev/commands/available` notification.
   *
   * This notification fires after mode switches and tool list updates, signaling
   * that kiro-cli has finished processing the change and the new tool set is ready.
   *
   * If `expectedTools` is provided, waits until ALL expected tool names are present
   * in the notification payload. If the timeout expires first, resolves with
   * whatever tools are currently available.
   */
  waitForToolsReady(options?: {
    timeoutMs?: number
    expectedTools?: string[]
  }): Promise<AvailableTool[]> {
    const { timeoutMs = 5000, expectedTools } = options ?? {}

    return new Promise<AvailableTool[]>((resolve) => {
      const timer = setTimeout(() => {
        this.removeToolsReadyListener(handler)
        resolve(this.availableTools) // resolve with whatever we have
      }, timeoutMs)

      const handler = (tools: AvailableTool[]): void => {
        // If no expected tools specified, resolve immediately on any notification
        if (!expectedTools) {
          clearTimeout(timer)
          this.removeToolsReadyListener(handler)
          resolve(tools)
          return
        }

        // Check if all expected tools are present
        const names = new Set(tools.map((t) => t.name))
        const allPresent = expectedTools.every((name) => names.has(name))
        if (allPresent) {
          clearTimeout(timer)
          this.removeToolsReadyListener(handler)
          resolve(tools)
        }
        // If not all present, keep waiting for next notification
      }
      this.addToolsReadyListener(handler)
    })
  }

  /** Register a listener for `_kiro.dev/commands/available` notifications. */
  addToolsReadyListener(listener: (tools: AvailableTool[]) => void): void {
    this.toolsReadyListeners.add(listener)
  }

  /** Remove a previously registered tools-ready listener. */
  removeToolsReadyListener(listener: (tools: AvailableTool[]) => void): void {
    this.toolsReadyListeners.delete(listener)
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
    // Resolve the bridge path on the real filesystem.
    // When this package is compiled into a Bun binary (bun build --compile),
    // import.meta.url resolves to a virtual path like /$bunfs/root/... which
    // doesn't exist on the real filesystem and can't be read via readFileSync.
    // Instead of trying to copy from the virtual path, we search for the real
    // file in node_modules.
    const bridgePath = this.resolveBridgePath()

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
   * Searches multiple locations to find the bridge script on the real
   * filesystem. This handles:
   * - Development with `file:` symlinks (bridge is next to this module)
   * - Normal npm/bun installs (bridge is in cwd/node_modules)
   * - Bun-compiled binaries where import.meta.url points to a virtual
   *   `/$bunfs/root/...` path that can't be read via readFileSync
   * - Bun's `.bun` cache directory structure
   * - Running from a project directory that doesn't have this package
   *   installed (walks up parent directories to find node_modules)
   * - Running from a compiled binary (searches relative to process.argv[0])
   */
  private resolveBridgePath(): string {
    // Strategy 1: Direct path next to this module (works in dev with file: symlink)
    // Wrapped in try-catch because import.meta.url may be empty/undefined in CJS builds.
    try {
      if (typeof import.meta?.url === "string" && import.meta.url) {
        const currentDir = dirname(fileURLToPath(import.meta.url))
        const directPath = join(currentDir, "mcp-bridge.js")
        if (!directPath.includes("$bunfs") && existsSync(directPath)) {
          return directPath
        }
      }
    } catch {
      // import.meta.url not available (CJS) — fall through to node_modules search
    }

    // Strategy 2: Search node_modules in cwd for the real package
    const nmBase = join(this.options.cwd, "node_modules")

    // Check direct node_modules
    const directNm = join(nmBase, "kiro-acp-ai-provider", "dist", "mcp-bridge.js")
    if (existsSync(directNm)) return directNm

    // Check bun's .bun cache directory
    const bunDir = join(nmBase, ".bun")
    if (existsSync(bunDir)) {
      try {
        const entries = readdirSync(bunDir)
        for (const entry of entries) {
          if (entry.includes("kiro-acp-ai-provider")) {
            const cached = join(
              bunDir,
              entry,
              "node_modules",
              "kiro-acp-ai-provider",
              "dist",
              "mcp-bridge.js",
            )
            if (existsSync(cached)) return cached
          }
        }
      } catch {
        // Ignore errors reading .bun cache
      }
    }

    // Strategy 3: Walk up from cwd looking for node_modules with our package.
    // When cwd is a user project (e.g. ~/my-app) that doesn't have this package
    // installed, the bridge won't be in cwd/node_modules. But the tool that
    // spawned us (e.g. opencode) has it in its own node_modules somewhere up
    // the directory tree.
    let searchDir = this.options.cwd
    for (let i = 0; i < 10; i++) {
      const candidate = join(searchDir, "node_modules", "kiro-acp-ai-provider", "dist", "mcp-bridge.js")
      if (existsSync(candidate)) return candidate

      // Also check bun's .bun cache in each ancestor
      const ancestorBunDir = join(searchDir, "node_modules", ".bun")
      if (existsSync(ancestorBunDir)) {
        try {
          for (const entry of readdirSync(ancestorBunDir)) {
            if (entry.includes("kiro-acp-ai-provider")) {
              const cached = join(
                ancestorBunDir,
                entry,
                "node_modules",
                "kiro-acp-ai-provider",
                "dist",
                "mcp-bridge.js",
              )
              if (existsSync(cached)) return cached
            }
          }
        } catch {
          // Ignore errors reading .bun cache
        }
      }

      const parent = dirname(searchDir)
      if (parent === searchDir) break // reached filesystem root
      searchDir = parent
    }

    // Strategy 4: Search relative to the binary/executable path.
    // When running as a compiled binary (e.g. opencode at
    // opencode/packages/opencode/dist/bin/opencode), the package's node_modules
    // may be several directories up from the binary location.
    const binDir = dirname(process.argv[0] || "")
    if (binDir) {
      let dir = binDir
      for (let i = 0; i < 10; i++) {
        const candidate = join(dir, "node_modules", "kiro-acp-ai-provider", "dist", "mcp-bridge.js")
        if (existsSync(candidate)) return candidate

        const binBunDir = join(dir, "node_modules", ".bun")
        if (existsSync(binBunDir)) {
          try {
            for (const entry of readdirSync(binBunDir)) {
              if (entry.includes("kiro-acp-ai-provider")) {
                const cached = join(
                  binBunDir,
                  entry,
                  "node_modules",
                  "kiro-acp-ai-provider",
                  "dist",
                  "mcp-bridge.js",
                )
                if (existsSync(cached)) return cached
              }
            }
          } catch {
            // Ignore errors reading .bun cache
          }
        }

        const parent = dirname(dir)
        if (parent === dir) break // reached filesystem root
        dir = parent
      }
    }

    // Strategy 5: Check temp dir (from a previous run)
    const tmpPath = join(tmpdir(), "kiro-acp", "mcp-bridge.js")
    if (existsSync(tmpPath)) return tmpPath

    throw new ACPConnectionError(
      "Could not find mcp-bridge.js. Ensure kiro-acp-ai-provider is installed.",
    )
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

      case "_kiro.dev/commands/available": {
        // Kiro-cli has finished processing a mode switch or tool list update.
        // Parse the available tools and notify all waiters so they can proceed.
        const tools = (Array.isArray(params.tools) ? params.tools : []) as AvailableTool[]
        this.availableTools = tools
        for (const listener of this.toolsReadyListeners) {
          listener(tools)
        }
        break
      }

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
