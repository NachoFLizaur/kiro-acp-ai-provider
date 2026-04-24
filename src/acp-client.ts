import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import { createInterface, type Interface as ReadlineInterface } from "node:readline"
import { createHash, randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import { dirname, join, isAbsolute } from "node:path"
import { existsSync, mkdirSync, chmodSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { generateAgentConfig, generateToollessAgentConfig, writeAgentConfig } from "./agent-config"
import { createIPCServer, type IPCServer } from "./ipc-server"
import { verifyAuth } from "./kiro-auth"
import type { LaneRouter } from "./lane-router"
import { verifyAuth } from "./kiro-auth"

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
const AGENT_CONFIG_LOCK_TIMEOUT_MS = 10_000
const AGENT_CONFIG_LOCK_RETRY_MS = 50
const AGENT_CONFIG_LOCK_STALE_MS = 30_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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

  /**
   * Per-instance unique ID for tools file isolation. Without this, concurrent
   * clients sharing the same cwd would clobber each other's tool definitions.
   */
  private readonly instanceId = randomBytes(4).toString("hex")

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

    const authStatus = verifyAuth()
    if (!authStatus.installed) {
      throw new KiroACPConnectionError("`kiro-cli` is not installed or not available on PATH.")
    }
    if (!authStatus.authenticated) {
      throw new KiroACPConnectionError("`kiro-cli` is not authenticated. Run `kiro-cli login` and retry.")
    }

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

    const initialize = async (): Promise<InitializeResult> => {
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
        const sanitizedAgent = this.options.agent.replace(/[^a-zA-Z0-9_-]/g, "_")
        args.push("--agent", sanitizedAgent)
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
            const detail = pending.method === "initialize" ? this.formatRecentStderr() : ""
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
          const detail = pending.method === "initialize" ? this.formatRecentStderr() : ""
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

    return this.options.agent
      ? this.withAgentConfigLock(initialize)
      : initialize()
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

  getCwd(): string {
    return this.options.cwd
  }

  getAgentName(): string | undefined {
    return this.options.agent
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

      return await this.withAgentConfigLock(async () => {
        if (this.options.agent) {
          const bridgePath = this.resolveBridgePath()
          const config = generateAgentConfig({
            name: this.options.agent,
            mcpBridgePath: bridgePath,
            toolsFilePath,
            cwd: this.options.cwd,
            prompt: this.options.agentPrompt,
          })
          writeAgentConfig(this.options.cwd, this.options.agent, config)
        }

        return this.sendNewSession()
      })
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
    const makeTmpPath = (path: string): string => `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`

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
            const tmpPath = makeTmpPath(toolsFile)
            writeFileSync(tmpPath, JSON.stringify(parsed, null, 2), { mode: 0o600 })
            renameSync(tmpPath, toolsFile)
          }
        } catch {
          // Will be handled by writeToolsFile later
        }
      }
    } else {
      toolsFile = this.getOrCreateToolsFilePath()
      const secret = this.ipcServer?.getSecret()
      const toolsData = {
        tools: [],
        cwd: this.options.cwd,
        ...(this.ipcPort != null ? { ipcPort: this.ipcPort } : {}),
        ...(secret ? { ipcSecret: secret } : {}),
      }
      const tmpPath = makeTmpPath(toolsFile)
      writeFileSync(tmpPath, JSON.stringify(toolsData, null, 2), { mode: 0o600 })
      renameSync(tmpPath, toolsFile)
    }

    const config = generateAgentConfig({
      name: this.options.agent,
      mcpBridgePath: bridgePath,
      toolsFilePath: toolsFile,
      cwd: this.options.cwd,
      prompt: this.options.agentPrompt,
    })

    writeAgentConfig(this.options.cwd, this.options.agent!, config)
  }

  private getAgentConfigLockPath(): string | null {
    if (!this.options.agent) return null

    const sanitizedAgent = this.options.agent.replace(/[^a-zA-Z0-9_-]/g, "_")
    return join(this.options.cwd, ".kiro", "agents", `${sanitizedAgent}.lock`)
  }

  private async withAgentConfigLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = this.getAgentConfigLockPath()
    if (!lockPath) return operation()

    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })

    const deadline = Date.now() + AGENT_CONFIG_LOCK_TIMEOUT_MS
    for (;;) {
      try {
        writeFileSync(
          lockPath,
          JSON.stringify({ pid: process.pid, instanceId: this.instanceId, createdAt: Date.now() }),
          { encoding: "utf-8", flag: "wx", mode: 0o600 },
        )
        break
      } catch (err) {
        const code = err instanceof Error && "code" in err ? String(err.code) : undefined
        if (code !== "EEXIST") throw err

        try {
          const lockStat = statSync(lockPath)
          if (Date.now() - lockStat.mtimeMs > AGENT_CONFIG_LOCK_STALE_MS) {
            unlinkSync(lockPath)
            continue
          }
        } catch {
          continue
        }

        if (Date.now() >= deadline) {
          throw new KiroACPConnectionError(`Timed out waiting for agent config lock: ${lockPath}`)
        }

        await sleep(AGENT_CONFIG_LOCK_RETRY_MS)
      }
    }

    try {
      return await operation()
    } finally {
      try {
        unlinkSync(lockPath)
      } catch {
        // Already gone
      }
    }
  }

  /**
   * Resolve the MCP bridge script to a real filesystem path.
   *
   * Handles: dev symlinks, npm/bun installs, Bun-compiled binaries
   * (virtual /$bunfs paths), .bun cache, and ancestor node_modules.
   */
  private resolveBridgePath(): string {
    // Strategy 1: Direct path next to this module (dev with file: symlink)
    try {
      if (typeof import.meta?.url === "string" && import.meta.url) {
        const currentDir = dirname(fileURLToPath(import.meta.url))
        const directPath = join(currentDir, "mcp-bridge.js")
        if (!directPath.includes("$bunfs") && existsSync(directPath)) {
          return directPath
        }
      }
    } catch {
      // import.meta.url not available (CJS)
    }

    // Strategy 2: node_modules in cwd
    const nmBase = join(this.options.cwd, "node_modules")

    const directNm = join(nmBase, "kiro-acp-ai-provider", "dist", "mcp-bridge.js")
    if (existsSync(directNm)) return directNm

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
              "mcp-bridge.js",
            )
            if (existsSync(cached)) return cached
          }
        }
      } catch {
        // Ignore
      }
    }

    // Strategy 3: Walk up from cwd
    let searchDir = this.options.cwd
    for (let i = 0; i < 10; i++) {
      const candidate = join(searchDir, "node_modules", "kiro-acp-ai-provider", "dist", "mcp-bridge.js")
      if (existsSync(candidate)) return candidate

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
          // Ignore
        }
      }

      const parent = dirname(searchDir)
      if (parent === searchDir) break
      searchDir = parent
    }

    // Strategy 4: Relative to binary/executable path
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
            // Ignore
          }
        }

        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    }

    // Strategy 5: process.execPath (Bun compiled binary returns "bun" for process.argv[0], but execPath is correct)
    const execDir = dirname(process.execPath || "")
    if (execDir && execDir !== ".") {
      let dir = execDir
      for (let i = 0; i < 10; i++) {
        const candidate = join(dir, "node_modules", "kiro-acp-ai-provider", "dist", "mcp-bridge.js")
        if (existsSync(candidate)) return candidate
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    }

    throw new KiroACPConnectionError(
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

  private createTimeoutError(method: string, timeoutMs: number): KiroACPError {
    const parts = [`Request timed out after ${timeoutMs}ms: ${method}`]
    if (method === "initialize") {
      const detail = this.formatRecentStderr()
      if (detail) {
        parts.push(detail.trimStart())
      }
    }

    return new KiroACPError(parts.join("\n\n"), -1)
  }

  private formatRecentStderr(): string {
    const stderr = this.stderrBuffer.trim()
    return stderr ? `\n\nkiro-cli stderr:\n${stderr}` : ""
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
