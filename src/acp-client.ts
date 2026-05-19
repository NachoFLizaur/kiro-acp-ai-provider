import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import { createInterface, type Interface as ReadlineInterface } from "node:readline"
import { createHash, randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import { dirname, join, isAbsolute } from "node:path"
import { existsSync, mkdirSync, chmodSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { getXdgDataHome } from "./session-storage"
import { generateAgentConfig, generateToollessAgentConfig, writeAgentConfig } from "./agent-config"
import { createIPCServer, type IPCServer } from "./ipc-server"
import type { LaneRouter } from "./lane-router"
import { verifyAuth } from "./kiro-auth"
import { MCP_BRIDGE_SOURCE } from "./mcp-bridge-source"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContentBlock {
  type: "text" | "image"
  text?: string
  data?: string
  mimeType?: string
}

export interface Mode {
  id: string
  name: string
  description?: string
  _meta?: { welcomeMessage?: string }
}

export interface Model {
  modelId: string
  name: string
  description?: string
}

export interface ACPSession {
  sessionId: string
  modes: { currentModeId: string; availableModes: Mode[] }
  models: { currentModelId: string; availableModels: Model[] }
}

export interface SessionUpdate {
  sessionUpdate: string
  [key: string]: unknown
}

export interface PermissionRequest {
  toolCall: {
    toolCallId: string
    name: string
    rawInput?: Record<string, unknown>
  }
  options: Array<{ id: string; label: string }>
}

export interface PermissionDecision {
  outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" }
}

export interface InitializeResult {
  agentInfo: { name: string; version: string }
  agentCapabilities: Record<string, unknown>
}

export interface CommandResult {
  success: boolean
  message: string
  data?: Record<string, unknown>
}

export interface AvailableTool {
  name: string
  source: string
  description?: string
}

export interface SessionMetadata {
  sessionId: string
  contextUsagePercentage?: number
  meteringUsage?: Array<{ unit: string; unitPlural: string; value: number }>
  turnDurationMs?: number
}

export interface ACPClientOptions {
  cwd: string
  agent?: string
  trustAllTools?: boolean
  env?: Record<string, string>
  agentPrompt?: string
  /** Default: auto-approve with "allow_always". */
  onPermission?: (request: PermissionRequest) => PermissionDecision
  onUpdate?: (sessionId: string, update: SessionUpdate) => void
  onExtension?: (method: string, params: Record<string, unknown>) => void
  clientInfo?: { name: string; version: string; title?: string }
  /** MCP tool call timeout in minutes (default: 30). */
  mcpTimeout?: number
}

export interface PromptOptions {
  sessionId: string
  prompt: ContentBlock[]
  onUpdate: (update: SessionUpdate) => void
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

export class KiroACPError extends Error {
  readonly name = "KiroACPError" as const
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message)
  }
}

export class KiroACPConnectionError extends Error {
  readonly name = "KiroACPConnectionError" as const
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
  timer: ReturnType<typeof setTimeout> | null
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
  startedToolless = false
  private stderrBuffer = ""
  private toolsFilePath: string | null = null
  private ipcServer: IPCServer | null = null
  private ipcPort: number | null = null
  private availableTools: AvailableTool[] = []
  private toolsReadyListeners = new Set<(tools: AvailableTool[]) => void>()

  /**
   * Per-instance unique ID for tools file isolation. Without this, concurrent
   * clients sharing the same cwd would clobber each other's tool definitions.
   */
  private readonly instanceId = randomBytes(4).toString("hex")

  /**
   * The unique agent name including the instanceId suffix. Used as the `name`
   * field inside the agent config JSON so that kiro-cli doesn't confuse
   * sessions from different instances sharing the same working directory.
   */
  private get uniqueAgentName(): string {
    const sanitizedAgent = this.options.agent!.replace(/[^a-zA-Z0-9_-]/g, "_")
    return `${sanitizedAgent}-${this.instanceId}`
  }

  private resolvedBridgePath?: string

  private readonly sessionToolsFiles = new Set<string>()

  /**
   * Mutex for serializing agent config rewrites + session creation.
   * Prevents race where model A rewrites config, model B overwrites it,
   * then model A creates a session reading model B's config.
   */
  private sessionCreationLock: Promise<void> = Promise.resolve()

  constructor(options: ACPClientOptions) {
    this.options = options
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Spawn kiro-cli acp and perform the initialize handshake.
   *
   * @param toolsFilePath - Optional path to a populated tools file. When
   *   provided, the agent config points to this file from the start so the
   *   MCP bridge sees the full tool set on its first query.
   */
  async start(toolsFilePath?: string): Promise<InitializeResult> {
    if (this.running) throw new KiroACPConnectionError("Client is already running")
    this.stderrBuffer = ""

    // Validate cwd is an absolute path to an existing directory
    const cwd = this.options.cwd
    if (!isAbsolute(cwd)) {
      throw new KiroACPError(`cwd must be absolute: ${cwd}`, -1)
    }
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new KiroACPError(`cwd is not a directory: ${cwd}`, -1)
    }

    // IPC server must start BEFORE setupAgentConfig so we have the port
    this.ipcServer = createIPCServer()
    this.ipcPort = await this.ipcServer.start()

    if (this.options.agent) {
      this.setupAgentConfig(toolsFilePath)
    }

    // Ensure MCP tool timeout is sufficient for long-running subagent tasks.
    // Default is 5 minutes which is too short for complex planning operations.
    try {
      execFileSync("kiro-cli", ["settings", "mcp.noInteractiveTimeout", String(this.options.mcpTimeout ?? 30)], {
        timeout: 5000,
        stdio: "ignore",
      })
    } catch {
      // Best-effort — setting may already be configured
    }

    const args = ["acp"]
    if (this.options.agent) {
      args.push("--agent", this.uniqueAgentName)
    }
    if (this.options.trustAllTools) args.push("--trust-all-tools")

    this.process = spawn("kiro-cli", args, {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.options.env },
    })

    this.running = true

    this.process.stderr?.on("data", (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString()
      if (this.stderrBuffer.length > 4096) {
        this.stderrBuffer = this.stderrBuffer.slice(-4096)
      }
    })

    // Must wait for readline to finish processing buffered lines before
    // rejecting pending requests — the process can write a valid response
    // to stdout and then exit.
    this.process.on("exit", (code, signal) => {
      this.running = false

      const rejectPending = () => {
        for (const [id, pending] of this.pending) {
          const detail = (pending.method === "initialize" || pending.method === "session/new") ? this.formatRecentStderr() : ""
          pending.reject(
            new KiroACPConnectionError(
              `Process exited (code=${code}, signal=${signal}) while waiting for ${pending.method}${detail}`,
            ),
          )
          clearTimeout(pending.timer ?? undefined)
          this.pending.delete(id)
        }
      }

      if (this.readline) {
        this.readline.once("close", rejectPending)
      } else {
        rejectPending()
      }
    })

    this.process.on("error", (err) => {
      this.running = false
      for (const [id, pending] of this.pending) {
        const detail = (pending.method === "initialize" || pending.method === "session/new") ? this.formatRecentStderr() : ""
        pending.reject(new KiroACPConnectionError(`Process error: ${err.message}${detail}`))
        clearTimeout(pending.timer ?? undefined)
        this.pending.delete(id)
      }
    })

    this.readline = createInterface({ input: this.process.stdout! })
    this.readline.on("line", (line) => this.handleLine(line))

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

    const initResult = result as InitializeResult
    if (!initResult || typeof initResult !== "object" || !("agentInfo" in initResult)) {
      throw new KiroACPError("Invalid response from initialize: missing agentInfo", -1)
    }
    return initResult
  }

  async stop(): Promise<void> {
    if (!this.running || !this.process) return

    this.running = false
    this.process.stdin?.end()

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

    for (const [id, pending] of this.pending) {
      pending.reject(new KiroACPConnectionError("Client stopped"))
      clearTimeout(pending.timer ?? undefined)
    }
    this.pending.clear()
    this.metadata.clear()
    this.promptCallbacks.clear()
    this.toolsReadyListeners.clear()
    this.availableTools = []

    if (this.ipcServer) {
      await this.ipcServer.stop()
      this.ipcServer = null
      this.ipcPort = null
    }

    if (this.toolsFilePath) {
      try {
        unlinkSync(this.toolsFilePath)
      } catch {
        // Already gone
      }
      this.toolsFilePath = null
    }

    for (const filePath of this.sessionToolsFiles) {
      try {
        unlinkSync(filePath)
      } catch {
        // Already gone
      }
    }
    this.sessionToolsFiles.clear()
  }

  // -------------------------------------------------------------------------
  // Session management
  // -------------------------------------------------------------------------

  async createSession(): Promise<ACPSession> {
    // No agent config rewrite — tools files are kept alive (not deleted
    // on cleanup), so any existing config still references a valid bridge.
    // Writing a toolless config here would race with createSessionWithToolsPath
    // and clobber the MCP bridge definition for concurrent sessions.
    return this.sendNewSession()
  }

  private async sendNewSession(): Promise<ACPSession> {
    const result = await this.sendRequest("session/new", {
      cwd: this.options.cwd,
      mcpServers: [],
    })
    const session = result as ACPSession
    if (!session || typeof session !== "object" || typeof session.sessionId !== "string") {
      throw new KiroACPError("Invalid response from session/new: missing sessionId", -1)
    }
    return session
  }

  async loadSession(sessionId: string): Promise<ACPSession> {
    const result = await this.sendRequest("session/load", {
      sessionId,
      cwd: this.options.cwd,
      mcpServers: [],
    })
    const session = result as ACPSession
    if (!session || typeof session !== "object") {
      throw new KiroACPError("Invalid response from session/load: expected object", -1)
    }
    if (!session.sessionId) session.sessionId = sessionId
    return session
  }

  // -------------------------------------------------------------------------
  // Prompting
  // -------------------------------------------------------------------------

  async prompt(options: PromptOptions): Promise<{ stopReason: string }> {
    const { sessionId, prompt, onUpdate, signal } = options

    this.promptCallbacks.set(sessionId, onUpdate)

    let abortHandler: (() => void) | undefined
    if (signal) {
      abortHandler = () => {
        this.sendNotification("session/cancel", { sessionId })
      }
      if (signal.aborted) {
        this.promptCallbacks.delete(sessionId)
        throw new KiroACPError("Prompt aborted before sending", -1)
      }
      signal.addEventListener("abort", abortHandler, { once: true })
    }

    try {
      // No timeout — tool execution can take arbitrarily long.
      // The abort signal is the proper cancellation mechanism.
      const result = await this.sendRequest(
        "session/prompt",
        { sessionId, prompt },
        0,
      )
      const promptResult = result as { stopReason: string }
      if (!promptResult || typeof promptResult !== "object" || typeof promptResult.stopReason !== "string") {
        throw new KiroACPError("Invalid response from session/prompt: missing stopReason", -1)
      }
      return promptResult
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

  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.executeCommand(sessionId, "model", { value: modelId })
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.sendRequest("session/set_mode", { sessionId, modeId })
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async executeCommand(
    sessionId: string,
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<CommandResult> {
    const result = await this.sendRequest("_kiro.dev/commands/execute", {
      sessionId,
      command: { command, args },
    })
    const commandResult = result as CommandResult
    if (!commandResult || typeof commandResult !== "object" || typeof commandResult.success !== "boolean") {
      throw new KiroACPError("Invalid response from commands/execute: missing success field", -1)
    }
    return commandResult
  }

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  getMetadata(sessionId: string): SessionMetadata | undefined {
    return this.metadata.get(sessionId)
  }

  getAllMetadata(): SessionMetadata[] {
    return [...this.metadata.values()]
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  isRunning(): boolean {
    return this.running
  }

  getStderr(): string {
    return this.stderrBuffer
  }

  private formatRecentStderr(): string {
    const stderr = this.stderrBuffer.trim()
    return stderr ? `\n\nkiro-cli stderr:\n${stderr}` : ""
  }

  private createTimeoutError(method: string, timeoutMs: number): KiroACPError {
    const parts = [`Request timed out after ${timeoutMs}ms: ${method}`]
    if (method === "initialize" || method === "session/new") {
      const detail = this.formatRecentStderr()
      if (detail) {
        parts.push(detail.trimStart())
      }
    }
    return new KiroACPError(parts.join("\n\n"), -1)
  }

  getCwd(): string {
    return this.options.cwd
  }

  getAgentName(): string | undefined {
    if (!this.options.agent) return undefined
    return this.uniqueAgentName
  }

  /** Return a copy of the construction options (for cloning). */
  getOptions(): ACPClientOptions {
    return { ...this.options }
  }

  /**
   * Create a new ACPClient with the same options.
   * The returned client is NOT started — call `start()` separately.
   */
  clone(): ACPClient {
    return new ACPClient(this.getOptions())
  }

  getAvailableTools(): AvailableTool[] {
    return [...this.availableTools]
  }

  getToolsFilePath(): string | null {
    return this.toolsFilePath
  }

  /**
   * Get or create the tools file path for this client instance.
   * Path: `{tmpdir}/kiro-acp/tools-{cwdHash}-{instanceId}.json`
   */
  getOrCreateToolsFilePath(): string {
    if (this.toolsFilePath) return this.toolsFilePath

    const toolsDir = join(tmpdir(), "kiro-acp")
    mkdirSync(toolsDir, { recursive: true, mode: 0o700 })
    chmodSync(toolsDir, 0o700) // Ensure correct perms even if dir pre-existed
    const cwdHash = createHash("md5").update(this.options.cwd).digest("hex").slice(0, 8)
    this.toolsFilePath = join(toolsDir, `tools-${cwdHash}-${this.instanceId}.json`)
    return this.toolsFilePath
  }

  /**
   * Create a unique tools file path for a specific ACP session.
   * Path: `{tmpdir}/kiro-acp/tools-{cwdHash}-{sessionUniqueId}.json`
   */
  createSessionToolsFilePath(sessionUniqueId: string): string {
    const toolsDir = join(tmpdir(), "kiro-acp")
    mkdirSync(toolsDir, { recursive: true, mode: 0o700 })
    chmodSync(toolsDir, 0o700) // Ensure correct perms even if dir pre-existed
    const cwdHash = createHash("md5").update(this.options.cwd).digest("hex").slice(0, 8)
    const filePath = join(toolsDir, `tools-${cwdHash}-${sessionUniqueId}.json`)
    this.sessionToolsFiles.add(filePath)
    return filePath
  }

  removeSessionToolsFile(filePath: string): void {
    this.sessionToolsFiles.delete(filePath)
    try {
      unlinkSync(filePath)
    } catch {
      // Already gone
    }
  }

  /**
   * Atomically rewrite the agent config to point to a different tools file,
   * then create a new session. Protected by a mutex to prevent concurrent
   * model instances from interfering.
   */
  async createSessionWithToolsPath(toolsFilePath: string): Promise<ACPSession> {
    const previousLock = this.sessionCreationLock
    let releaseLock: () => void
    this.sessionCreationLock = new Promise<void>((resolve) => {
      releaseLock = resolve
    })

    try {
      await previousLock

      if (this.options.agent) {
        const bridgePath = this.resolveBridgePath()
        const config = generateAgentConfig({
          name: this.uniqueAgentName,
          mcpBridgePath: bridgePath,
          toolsFilePath,
          cwd: this.options.cwd,
          prompt: this.options.agentPrompt,
        })
        writeAgentConfig(this.options.cwd, this.options.agent, config, this.instanceId)
      }

      return await this.sendNewSession()
    } finally {
      releaseLock!()
    }
  }

  getIpcPort(): number | null {
    return this.ipcPort
  }

  getIpcSecret(): string | null {
    return this.ipcServer?.getSecret() ?? null
  }

  getIPCServer(): IPCServer | null {
    return this.ipcServer
  }

  getLaneRouter(): LaneRouter | null {
    return this.ipcServer?.getLaneRouter() ?? null
  }

  /** Replace the prompt callback for a session (used during resumption). */
  setPromptCallback(sessionId: string, callback: (update: SessionUpdate) => void): void {
    this.promptCallbacks.set(sessionId, callback)
  }

  /**
   * Wait for kiro-cli to send `_kiro.dev/commands/available`.
   * Fires after mode switches and tool list updates.
   *
   * If `expectedTools` is provided, waits until all are present.
   * Resolves with current tools on timeout.
   */
  waitForToolsReady(options?: {
    timeoutMs?: number
    expectedTools?: string[]
  }): Promise<AvailableTool[]> {
    const { timeoutMs = 5000, expectedTools } = options ?? {}

    return new Promise<AvailableTool[]>((resolve) => {
      const timer = setTimeout(() => {
        this.removeToolsReadyListener(handler)
        resolve(this.availableTools)
      }, timeoutMs)

      const handler = (tools: AvailableTool[]): void => {
        if (!expectedTools) {
          clearTimeout(timer)
          this.removeToolsReadyListener(handler)
          resolve(tools)
          return
        }

        const names = new Set(tools.map((t) => t.name))
        const allPresent = expectedTools.every((name) => names.has(name))
        if (allPresent) {
          clearTimeout(timer)
          this.removeToolsReadyListener(handler)
          resolve(tools)
        }
      }
      this.addToolsReadyListener(handler)
    })
  }

  addToolsReadyListener(listener: (tools: AvailableTool[]) => void): void {
    this.toolsReadyListeners.add(listener)
  }

  removeToolsReadyListener(listener: (tools: AvailableTool[]) => void): void {
    this.toolsReadyListeners.delete(listener)
  }

  // -------------------------------------------------------------------------
  // Internal: Agent config setup
  // -------------------------------------------------------------------------

  /**
   * Generate and write the agent config file.
   *
   * When a populated tools file path is provided, the config points directly
   * to it. Otherwise creates a placeholder (safe because createSessionWithToolsPath
   * rewrites the config before any session is created).
   */
  private setupAgentConfig(populatedToolsFilePath?: string): void {
    const bridgePath = this.resolveBridgePath()

    let toolsFile: string
    if (populatedToolsFilePath) {
      toolsFile = populatedToolsFilePath
      // Inject ipcPort and ipcSecret if the model wrote tools before start() was called
      if (this.ipcPort != null) {
        try {
          const existing = readFileSync(toolsFile, "utf-8")
          const parsed = JSON.parse(existing) as { ipcPort?: number; ipcSecret?: string }
          const secret = this.ipcServer?.getSecret()
          if (parsed.ipcPort !== this.ipcPort || (secret && parsed.ipcSecret !== secret)) {
            ;(parsed as Record<string, unknown>).ipcPort = this.ipcPort
            if (secret) (parsed as Record<string, unknown>).ipcSecret = secret
            const tmpPath = `${toolsFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
            writeFileSync(tmpPath, JSON.stringify(parsed, null, 2), { mode: 0o600 })
            renameSync(tmpPath, toolsFile)
          }
        } catch {
          // Will be handled by writeToolsFile later
        }
      }
    } else {
      // No tools provided (e.g., title generation call) — write a toolless config
      // so kiro-cli doesn't spawn a dead MCP bridge that blocks later tool loading.
      const config = generateToollessAgentConfig({
        name: this.uniqueAgentName,
        prompt: this.options.agentPrompt,
      })
      writeAgentConfig(this.options.cwd, this.options.agent!, config, this.instanceId)
      return // Early return — no MCP bridge needed for toolless startup
    }

    const config = generateAgentConfig({
      name: this.uniqueAgentName,
      mcpBridgePath: bridgePath,
      toolsFilePath: toolsFile,
      cwd: this.options.cwd,
      prompt: this.options.agentPrompt,
    })

    writeAgentConfig(this.options.cwd, this.options.agent!, config, this.instanceId)
  }

  /**
   * Walk up parent directories from `startDir`, checking for mcp-bridge.mjs
   * in node_modules (both standard and Bun's .bun cache).
   */
  private findBridgeInAncestors(startDir: string, maxDepth = 10): string | undefined {
    let dir = startDir
    for (let i = 0; i < maxDepth; i++) {
      const candidate = join(dir, "node_modules", "kiro-acp-ai-provider", "dist", "mcp-bridge.mjs")
      if (existsSync(candidate)) return candidate

      const bunDir = join(dir, "node_modules", ".bun")
      if (existsSync(bunDir)) {
        try {
          for (const entry of readdirSync(bunDir)) {
            if (entry.includes("kiro-acp-ai-provider")) {
              const cached = join(bunDir, entry, "node_modules", "kiro-acp-ai-provider", "dist", "mcp-bridge.mjs")
              if (existsSync(cached)) return cached
            }
          }
        } catch { /* ignore */ }
      }

      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return undefined
  }

  /**
   * Resolve the MCP bridge script to a real filesystem path.
   *
   * Handles: dev symlinks, npm/bun installs, Bun-compiled binaries
   * (virtual /$bunfs paths), .bun cache, ancestor node_modules, and
   * XDG extraction for compiled binaries.
   */
  private resolveBridgePath(): string {
    if (this.resolvedBridgePath) return this.resolvedBridgePath

    // Strategy 1: Direct path next to this module (dev with file: symlink)
    try {
      if (typeof import.meta?.url === "string" && import.meta.url) {
        const currentDir = dirname(fileURLToPath(import.meta.url))
        const directPath = join(currentDir, "mcp-bridge.mjs")
        if (!directPath.includes("$bunfs") && existsSync(directPath)) {
          this.resolvedBridgePath = directPath
          return directPath
        }
      }
    } catch {
      // import.meta.url not available (CJS)
    }

    // Strategy 2: node_modules in cwd
    const nmBase = join(this.options.cwd, "node_modules")

    const directNm = join(nmBase, "kiro-acp-ai-provider", "dist", "mcp-bridge.mjs")
    if (existsSync(directNm)) {
      this.resolvedBridgePath = directNm
      return directNm
    }

    // Check bun's .bun cache
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
              "mcp-bridge.mjs",
            )
            if (existsSync(cached)) {
              this.resolvedBridgePath = cached
              return cached
            }
          }
        }
      } catch {
        // Ignore
      }
    }

    // Strategy 3: Walk up from cwd
    const fromCwd = this.findBridgeInAncestors(this.options.cwd)
    if (fromCwd) {
      this.resolvedBridgePath = fromCwd
      return fromCwd
    }

    // Strategy 4: Relative to binary/executable path
    const binDir = dirname(process.argv[0] || "")
    if (binDir) {
      const fromBin = this.findBridgeInAncestors(binDir)
      if (fromBin) {
        this.resolvedBridgePath = fromBin
        return fromBin
      }
    }

    // Strategy 5: Extract embedded bridge to XDG data directory (compiled binary)
    if (MCP_BRIDGE_SOURCE) {
      const dataDir = getXdgDataHome()
      const bridgeDir = join(dataDir, "kiro-acp-ai-provider")
      const bridgePath = join(bridgeDir, "mcp-bridge.mjs")

      if (existsSync(bridgePath)) {
        try {
          if (readFileSync(bridgePath, "utf-8") === MCP_BRIDGE_SOURCE) {
            this.resolvedBridgePath = bridgePath
            return bridgePath
          }
        } catch { /* re-extract below */ }
      }

      mkdirSync(bridgeDir, { recursive: true, mode: 0o700 })

      // Best-effort cleanup of the legacy `.js` extraction (pre-1.7.8).
      // The old file fails to load under Node because the XDG dir has no
      // package.json declaring `"type": "module"`. Removing it avoids
      // confusion and keeps the directory tidy.
      try {
        unlinkSync(join(bridgeDir, "mcp-bridge.js"))
      } catch { /* not present, ignore */ }

      const tmpPath = `${bridgePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
      writeFileSync(tmpPath, MCP_BRIDGE_SOURCE, { mode: 0o600, flag: "wx" })
      renameSync(tmpPath, bridgePath)

      this.resolvedBridgePath = bridgePath
      return bridgePath
    }

    throw new KiroACPConnectionError(
      "Could not find mcp-bridge.mjs. Ensure kiro-acp-ai-provider is installed.",
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
        reject(new KiroACPConnectionError("Client is not running"))
        return
      }

      const id = this.nextId++
      const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params }

      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(id)
            if (method === "session/prompt") {
              const sid = (params as Record<string, unknown>)?.sessionId as string | undefined
              if (sid) {
                this.sendNotification("session/cancel", { sessionId: sid })
              }
            }
            // On initialize/session/new timeout, check if auth expired (kiro-cli hangs silently when not authenticated)
            if (method === "initialize" || method === "session/new") {
              const auth = verifyAuth()
              if (!auth.authenticated) {
                reject(new KiroACPError("Not logged in. Run 'kiro-cli login' to authenticate.", -1))
                return
              }
            }
            reject(this.createTimeoutError(method, timeoutMs))
          }, timeoutMs)
        : null

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
      return
    }

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

    clearTimeout(pending.timer ?? undefined)
    this.pending.delete(msg.id)

    if (msg.error) {
      const errorMessage = msg.error.message || `JSON-RPC error (code: ${msg.error.code ?? "unknown"})`
      pending.reject(new KiroACPError(errorMessage, msg.error.code, msg.error.data))
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
        this.sendResponse(msg.id, null)
        break
    }
  }

  private handlePermissionRequest(id: number, request: PermissionRequest): void {
    if (this.options.onPermission) {
      const decision = this.options.onPermission(request)
      this.sendResponse(id, decision)
    } else {
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
        this.handleSessionUpdate(params)
        break

      case "_kiro.dev/commands/available": {
        const tools = (Array.isArray(params.tools) ? params.tools : []) as AvailableTool[]
        this.availableTools = tools
        for (const listener of this.toolsReadyListeners) {
          listener(tools)
        }
        break
      }

      default:
        this.options.onExtension?.(msg.method, params)
        break
    }
  }

  private handleSessionUpdate(params: Record<string, unknown>): void {
    const sessionId = params.sessionId as string | undefined
    const update = params.update as SessionUpdate | undefined

    if (!update) return

    if (sessionId) {
      const callback = this.promptCallbacks.get(sessionId)
      callback?.(update)
    }

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
