// ACP Client
export {
  ACPClient,
  KiroACPError,
  KiroACPConnectionError,
  type ACPClientOptions,
  type ACPSession,
  type AvailableTool,
  type ContentBlock,
  type Mode,
  type Model,
  type SessionUpdate,
  type PermissionRequest,
  type PermissionDecision,
  type InitializeResult,
  type CommandResult,
  type SessionMetadata,
  type PromptOptions,
} from "./acp-client"

// Language Model
export { KiroACPLanguageModel, type KiroACPModelConfig } from "./kiro-acp-model"

// Session affinity: x-session-affinity/x-session-reset header protocol helpers.
export { interceptSessionAffinity, hashPromptMessages, diverged } from "./session-affinity"

// Provider
export {
  createKiroAcp,
  type KiroACPProvider,
  type KiroACPProviderSettings,
  type KiroACPModelOverrides,
} from "./kiro-acp-provider"

// Agent Config
export {
  generateAgentConfig,
  writeAgentConfig,
  type AgentConfigOptions,
} from "./agent-config"

// MCP Bridge Tools
export {
  type MCPToolDefinition,
  type MCPToolInputSchema,
  type MCPToolsFile,
} from "./mcp-bridge-tools"

// IPC Server — types only at the root. AI-SDK provider auto-discovery (e.g.
// in a host like opencode) selects the first sorted `create*` export as the
// factory; a root `createIPCServer` would sort before and shadow
// `createKiroAcp` ("I" < "K"). Keeping `createIPCServer` off the root ensures
// `createKiroAcp` is chosen — it ships on the `./ipc` subpath instead.
// Type-only exports add no runtime namespace keys, so they are safe here.
export {
  type IPCServer,
  type IPCServerOptions,
  type IPCContentBlock,
  type PendingToolCall,
  type ToolResultRequest,
  type ToolExecuteResponse,
} from "./ipc-server"

// Utilities
export { verifyAuth, type AuthStatus } from "./kiro-auth"
export {
  listModels,
  type ListModelsOptions,
} from "./kiro-models"
export { getQuota, type QuotaInfo, type GetQuotaOptions } from "./kiro-quota"
