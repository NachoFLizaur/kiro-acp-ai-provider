import { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamResult, LanguageModelV3GenerateResult } from '@ai-sdk/provider';

declare class LaneRouter {
    private readonly lanes;
    private readonly bufferedCalls;
    register(sessionId: string, handler: (call: PendingToolCall) => void): void;
    unregister(sessionId: string): void;
    /** Update the handler for an existing lane (used during resumption). */
    updateHandler(sessionId: string, handler: (call: PendingToolCall) => void): void;
    /**
     * Record a pending correlation from an ACP tool_call notification.
     * Creates a "reservation" that the next matching IPC call should be
     * routed to this session's lane.
     */
    correlate(sessionId: string, toolCallId: string, toolName: string, args: Record<string, unknown>): void;
    route(call: PendingToolCall): void;
    /**
     * Find a lane with a matching correlation (toolName + args deep equality).
     * Uses oldest correlation timestamp as tiebreaker (FIFO).
     */
    private findMatchingLane;
    /** Remove the first matching correlation to prevent double-matching. */
    private consumeCorrelation;
    /**
     * Buffer an IPC call with no matching correlation yet.
     * The ACP notification may arrive slightly after the IPC call.
     * On timeout, falls back to the most recently registered lane.
     */
    private bufferCall;
    private drainBufferedCalls;
    /** Fallback: route to the most recently registered lane. */
    private routeFallback;
    getLaneCount(): number;
    getBufferedCallCount(): number;
    clear(): void;
}

interface PendingToolCall {
    callId: string;
    toolName: string;
    args: Record<string, unknown>;
}
/** Content block for IPC transport — text or image. */
interface IPCContentBlock {
    type: "text" | "image";
    text?: string;
    data?: string;
    mimeType?: string;
}
interface ToolResultRequest {
    callId: string;
    result: string;
    isError?: boolean;
    /** Structured content blocks (text + images). When present, takes precedence over `result`. */
    content?: IPCContentBlock[];
}
interface ToolExecuteResponse {
    status: "success" | "error" | "ok";
    result?: string;
    error?: string;
    code?: string;
    /** Structured content blocks (text + images). When present, MCP bridge should use these. */
    content?: IPCContentBlock[];
}
interface IPCServerOptions {
    host?: string;
}
interface IPCServer {
    start(): Promise<number>;
    stop(): Promise<void>;
    getPort(): number | null;
    getSecret(): string;
    getPendingCount(): number;
    getLaneRouter(): LaneRouter;
    resolveToolResult(request: ToolResultRequest): void;
}
declare function createIPCServer(options?: IPCServerOptions): IPCServer;

interface ContentBlock {
    type: "text" | "image";
    text?: string;
    data?: string;
    mimeType?: string;
}
interface Mode {
    id: string;
    name: string;
    description?: string;
    _meta?: {
        welcomeMessage?: string;
    };
}
interface Model {
    modelId: string;
    name: string;
    description?: string;
}
interface ACPSession {
    sessionId: string;
    modes: {
        currentModeId: string;
        availableModes: Mode[];
    };
    models: {
        currentModelId: string;
        availableModels: Model[];
    };
}
interface SessionUpdate {
    sessionUpdate: string;
    [key: string]: unknown;
}
interface PermissionRequest {
    toolCall: {
        toolCallId: string;
        name: string;
        rawInput?: Record<string, unknown>;
    };
    options: Array<{
        id: string;
        label: string;
    }>;
}
interface PermissionDecision {
    outcome: {
        outcome: "selected";
        optionId: string;
    } | {
        outcome: "cancelled";
    };
}
interface InitializeResult {
    agentInfo: {
        name: string;
        version: string;
    };
    agentCapabilities: Record<string, unknown>;
}
interface CommandResult {
    success: boolean;
    message: string;
    data?: Record<string, unknown>;
}
interface AvailableTool {
    name: string;
    source: string;
    description?: string;
}
interface SessionMetadata {
    sessionId: string;
    contextUsagePercentage?: number;
    meteringUsage?: Array<{
        unit: string;
        unitPlural: string;
        value: number;
    }>;
    turnDurationMs?: number;
}
interface ACPClientOptions {
    cwd: string;
    agent?: string;
    trustAllTools?: boolean;
    env?: Record<string, string>;
    agentPrompt?: string;
    /** Default: auto-approve with "allow_always". */
    onPermission?: (request: PermissionRequest) => PermissionDecision;
    onUpdate?: (sessionId: string, update: SessionUpdate) => void;
    onExtension?: (method: string, params: Record<string, unknown>) => void;
    clientInfo?: {
        name: string;
        version: string;
        title?: string;
    };
    /** MCP tool call timeout in minutes (default: 30). */
    mcpTimeout?: number;
}
interface PromptOptions {
    sessionId: string;
    prompt: ContentBlock[];
    onUpdate: (update: SessionUpdate) => void;
    signal?: AbortSignal;
}
declare class KiroACPError extends Error {
    readonly code?: number | undefined;
    readonly data?: unknown | undefined;
    readonly name: "KiroACPError";
    constructor(message: string, code?: number | undefined, data?: unknown | undefined);
}
declare class KiroACPConnectionError extends Error {
    readonly name: "KiroACPConnectionError";
    constructor(message: string);
}
declare class ACPClient {
    private readonly options;
    private process;
    private readline;
    private nextId;
    private readonly pending;
    private readonly metadata;
    private readonly promptCallbacks;
    private running;
    private stderrBuffer;
    private toolsFilePath;
    private ipcServer;
    private ipcPort;
    private availableTools;
    private toolsReadyListeners;
    private _startedToolless;
    private _startPromise;
    /**
     * Per-instance unique ID for tools file isolation. Without this, concurrent
     * clients sharing the same cwd would clobber each other's tool definitions.
     */
    private readonly instanceId;
    private readonly sessionToolsFiles;
    /**
     * Mutex for serializing agent config rewrites + session creation.
     * Prevents race where model A rewrites config, model B overwrites it,
     * then model A creates a session reading model B's config.
     */
    private sessionCreationLock;
    constructor(options: ACPClientOptions);
    /**
     * Spawn kiro-cli acp and perform the initialize handshake.
     *
     * @param toolsFilePath - Optional path to a populated tools file. When
     *   provided, the agent config points to this file from the start so the
     *   MCP bridge sees the full tool set on its first query.
     */
    start(toolsFilePath?: string): Promise<InitializeResult>;
    private _doStart;
    stop(): Promise<void>;
    createSession(): Promise<ACPSession>;
    private sendNewSession;
    loadSession(sessionId: string): Promise<ACPSession>;
    prompt(options: PromptOptions): Promise<{
        stopReason: string;
    }>;
    setModel(sessionId: string, modelId: string): Promise<void>;
    setMode(sessionId: string, modeId: string): Promise<void>;
    executeCommand(sessionId: string, command: string, args?: Record<string, unknown>): Promise<CommandResult>;
    getMetadata(sessionId: string): SessionMetadata | undefined;
    getAllMetadata(): SessionMetadata[];
    isRunning(): boolean;
    isStartedToolless(): boolean;
    getStderr(): string;
    getCwd(): string;
    getAgentName(): string | undefined;
    /** Return a copy of the construction options (for cloning). */
    getOptions(): ACPClientOptions;
    /**
     * Create a new ACPClient with the same options.
     * The returned client is NOT started — call `start()` separately.
     */
    clone(): ACPClient;
    getAvailableTools(): AvailableTool[];
    getToolsFilePath(): string | null;
    /**
     * Get or create the tools file path for this client instance.
     * Path: `{tmpdir}/kiro-acp/tools-{cwdHash}-{instanceId}.json`
     */
    getOrCreateToolsFilePath(): string;
    /**
     * Create a unique tools file path for a specific ACP session.
     * Path: `{tmpdir}/kiro-acp/tools-{cwdHash}-{sessionUniqueId}.json`
     */
    createSessionToolsFilePath(sessionUniqueId: string): string;
    removeSessionToolsFile(filePath: string): void;
    /**
     * Atomically rewrite the agent config to point to a different tools file,
     * then create a new session. Protected by a mutex to prevent concurrent
     * model instances from interfering.
     */
    createSessionWithToolsPath(toolsFilePath: string): Promise<ACPSession>;
    getIpcPort(): number | null;
    getIpcSecret(): string | null;
    getIPCServer(): IPCServer | null;
    getLaneRouter(): LaneRouter | null;
    /** Replace the prompt callback for a session (used during resumption). */
    setPromptCallback(sessionId: string, callback: (update: SessionUpdate) => void): void;
    /**
     * Wait for kiro-cli to send `_kiro.dev/commands/available`.
     * Fires after mode switches and tool list updates.
     *
     * If `expectedTools` is provided, waits until all are present.
     * Resolves with current tools on timeout.
     */
    waitForToolsReady(options?: {
        timeoutMs?: number;
        expectedTools?: string[];
    }): Promise<AvailableTool[]>;
    addToolsReadyListener(listener: (tools: AvailableTool[]) => void): void;
    removeToolsReadyListener(listener: (tools: AvailableTool[]) => void): void;
    /**
     * Generate and write the agent config file.
     *
     * When a populated tools file path is provided, the config points directly
     * to it. Otherwise creates a placeholder (safe because createSessionWithToolsPath
     * rewrites the config before any session is created).
     */
    private setupAgentConfig;
    private getAgentConfigLockPath;
    private withAgentConfigLock;
    /**
     * Resolve the MCP bridge script to a real filesystem path.
     *
     * Handles: dev symlinks, npm/bun installs, Bun-compiled binaries
     * (virtual /$bunfs paths), .bun cache, and ancestor node_modules.
     */
    private resolveBridgePath;
    private sendRequest;
    private createTimeoutError;
    private formatRecentStderr;
    private sendNotification;
    private sendResponse;
    private handleLine;
    private handleResponse;
    private handleServerRequest;
    private handlePermissionRequest;
    private handleNotification;
    private handleSessionUpdate;
    private handleMetadata;
}

interface KiroACPModelConfig {
    client: ACPClient;
    sessionId?: string;
    /** Max context window in tokens. Default: 1_000_000. */
    contextWindow?: number;
}
/**
 * LanguageModelV3 implementation backed by kiro-cli via ACP.
 *
 * Each doStream() creates a new ACP session with its own tools file.
 * Sessions with affinity (`x-session-affinity` header) are persisted
 * and resumed; sessions without affinity are one-shot.
 *
 * System prompts are injected via `<system_instructions>` tags.
 * Tool calls use the standard AI SDK contract (no providerExecuted flag).
 */
declare class KiroACPLanguageModel implements LanguageModelV3 {
    readonly specificationVersion: "v3";
    readonly provider = "kiro-acp";
    readonly modelId: string;
    readonly defaultObjectGenerationMode: undefined;
    readonly supportedUrls: Record<string, RegExp[]>;
    private readonly client;
    private readonly config;
    private currentModelId;
    private totalCredits;
    private currentAffinityId;
    /**
     * Per-session tools file paths. Each ACP session gets its own file
     * so concurrent sessions don't overwrite each other's tool definitions.
     */
    private sessionToolsFiles;
    /**
     * Per-session state for prompts paused waiting for tool results.
     * When a tool call arrives via IPC, we close the stream and store state here.
     * The next doStream() (with tool results) uses this to resume.
     */
    private pendingTurns;
    /**
     * Isolated ACP clients for subagent sessions (separate kiro-cli processes).
     * Each subagent gets its own process to prevent tool leakage between parent
     * and child sessions that would otherwise share the same kiro-cli process.
     */
    private subClients;
    constructor(modelId: string, config: KiroACPModelConfig);
    getTotalCredits(): number;
    /**
     * Ensure the ACP client is started. Safe to call multiple times.
     * If initialization fails, subsequent calls will retry.
     */
    private ensureClient;
    /**
     * Create a new ACP session for this doStream() call.
     *
     * Each doStream() gets a fresh session with its own tools file.
     * With affinity, tries to resume a persisted session first.
     * Without affinity (subagent calls), always creates fresh.
     */
    private acquireSession;
    /**
     * Clean up after a doStream() lifecycle completes.
     *
     * With affinity: persist mapping, keep kiro session alive, remove tools file.
     * Without affinity: full cleanup (one-shot session).
     */
    private cleanupAfterStream;
    /**
     * Ensure a session uses the correct agent mode.
     *
     * Only the first session inherits the `--agent` flag's mode.
     * Subsequent sessions default to `kiro_default`, so we explicitly
     * set the mode after creation/loading.
     */
    private ensureSessionMode;
    /** Switch model on a session if the requested modelId differs. */
    private ensureModel;
    setAffinityId(affinityId: string | undefined): void;
    getSessionId(): string | null;
    /**
     * Inject conversation context into a new session.
     * Used when session/load fails and we need to rehydrate from the consumer's history.
     */
    injectContext(summary: string): Promise<void>;
    /**
     * Write tool definitions to a tools file in MCP format.
     * Only function tools are synced — provider tools are handled by the provider itself.
     * @returns Sorted tool names string (for change detection).
     */
    private writeToolsToFile;
    private syncToolsToBridgePath;
    private ensureIpcPortInToolsFile;
    /**
     * Ensure tools file has executable tool definitions and IPC wiring.
     *
     * If file contents are stale/incomplete, attempts one in-place repair by
     * rewriting tools + IPC fields, then validates again.
     */
    private ensureToolsFileReady;
    private cleanupSessionToolsFile;
    /**
     * Extract tool results from `role: "tool"` messages in the prompt.
     */
    private extractToolResults;
    doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult>;
    private static readonly SUB_CLIENT_IDLE_MS;
    /**
     * Route a subagent doStream() call to an isolated KiroACPLanguageModel
     * backed by its own ACPClient (separate kiro-cli process).
     *
     * The isolated client is reused across turns for the same affinityId
     * (tool call → tool result → continuation) and cleaned up after 60s idle.
     */
    private doStreamIsolated;
    /**
     * Shutdown all isolated subagent clients.
     * Call this when the parent provider is shutting down.
     */
    shutdownSubClients(): Promise<void>;
    /** Find the pending turn whose tool call IDs match the given tool results. */
    private findPendingTurnForResults;
    /**
     * Create the stream infrastructure shared by both fresh prompts and
     * tool-result resumptions.
     *
     * Returns the readable stream, an update handler for ACP notifications,
     * and completion/error handlers that wire up the prompt promise to the
     * stream lifecycle.
     */
    private createPromptStream;
    private startFreshPrompt;
    private resumeWithToolResults;
    private sendToolResult;
    doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult>;
}

interface KiroACPProviderSettings {
    cwd?: string;
    model?: string;
    agent?: string;
    trustAllTools?: boolean;
    agentPrompt?: string;
    onPermission?: (request: PermissionRequest) => PermissionDecision;
    env?: Record<string, string>;
    clientInfo?: {
        name: string;
        version: string;
        title?: string;
    };
    sessionId?: string;
    /** Max context window in tokens. Default: 1_000_000. */
    contextWindow?: number;
    /** MCP tool call timeout in minutes. Default: 30. */
    mcpTimeout?: number;
}
interface KiroACPModelOverrides {
    contextWindow?: number;
}
interface KiroACPProvider {
    (modelId: string, overrides?: KiroACPModelOverrides): LanguageModelV3;
    languageModel(modelId: string, overrides?: KiroACPModelOverrides): LanguageModelV3;
    shutdown(): Promise<void>;
    getClient(): ACPClient;
    getSessionId(): string | null;
    injectContext(summary: string): Promise<void>;
    getTotalCredits(): number;
}
/**
 * Create a KiroACP provider backed by a single kiro-cli process.
 *
 * ```ts
 * const kiro = createKiroAcp({ cwd: "/path/to/project" })
 * const model = kiro("claude-sonnet-4.6")
 * const result = await generateText({ model, prompt: "Hello!" })
 * await kiro.shutdown()
 * ```
 */
declare function createKiroAcp(settings?: KiroACPProviderSettings): KiroACPProvider;

interface AgentConfigOptions {
    name?: string;
    mcpBridgePath: string;
    toolsFilePath: string;
    cwd: string;
    prompt?: string;
    model?: string;
}
/**
 * Generate the agent configuration object for kiro-cli.
 *
 * Configures: MCP-only tools (no built-ins), auto-approve all MCP calls,
 * MCP bridge server via stdio, and a meta-prompt that defers to per-request
 * `<system_instructions>`.
 */
declare function generateAgentConfig(options: AgentConfigOptions): Record<string, unknown>;
/** Write an agent config to `.kiro/agents/<name>.json`. Returns the path. */
declare function writeAgentConfig(dir: string, name: string, config: Record<string, unknown>): string;

interface MCPToolInputSchema {
    type: "object";
    properties: Record<string, {
        type: string;
        description?: string;
        default?: unknown;
        enum?: unknown[];
    }>;
    required?: string[];
    additionalProperties?: boolean;
}
interface MCPToolDefinition {
    name: string;
    description: string;
    inputSchema: MCPToolInputSchema;
}
interface MCPToolsFile {
    tools: MCPToolDefinition[];
    cwd?: string;
    ipcPort?: number;
    ipcSecret?: string;
}

interface AuthStatus {
    installed: boolean;
    authenticated: boolean;
    version?: string;
    tokenPath?: string;
}
/** Check if kiro-cli is installed and authenticated. */
declare function verifyAuth(): AuthStatus;

interface ListModelsOptions {
    cwd?: string;
}
/** List available models. Temporarily starts kiro-cli, reads models, then shuts down. */
declare function listModels(options?: ListModelsOptions): Promise<Model[]>;

interface QuotaInfo {
    sessionCredits: number;
    contextUsagePercentage?: number;
    metering?: Array<{
        unit: string;
        unitPlural: string;
        value: number;
    }>;
}
interface GetQuotaOptions {
    client?: ACPClient;
    cwd?: string;
}
/**
 * Get per-session credit usage from _kiro.dev/metadata.
 * Full subscription details (plan type, monthly limits) are not available via ACP.
 */
declare function getQuota(options?: GetQuotaOptions): Promise<QuotaInfo>;

export { ACPClient, type ACPClientOptions, type ACPSession, type AgentConfigOptions, type AuthStatus, type AvailableTool, type CommandResult, type ContentBlock, type GetQuotaOptions, type IPCContentBlock, type IPCServer, type IPCServerOptions, type InitializeResult, KiroACPConnectionError, KiroACPError, KiroACPLanguageModel, type KiroACPModelConfig, type KiroACPModelOverrides, type KiroACPProvider, type KiroACPProviderSettings, type ListModelsOptions, type MCPToolDefinition, type MCPToolInputSchema, type MCPToolsFile, type Mode, type Model, type PendingToolCall, type PermissionDecision, type PermissionRequest, type PromptOptions, type QuotaInfo, type SessionMetadata, type SessionUpdate, type ToolExecuteResponse, type ToolResultRequest, createIPCServer, createKiroAcp, generateAgentConfig, getQuota, listModels, verifyAuth, writeAgentConfig };
