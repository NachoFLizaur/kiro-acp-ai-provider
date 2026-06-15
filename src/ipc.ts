// Subpath entry: `kiro-acp-ai-provider/ipc`.
//
// `createIPCServer` deliberately lives OFF the root export: AI-SDK provider
// auto-discovery (e.g. in a host like opencode) picks the FIRST key of the
// sorted root ESM namespace matching `create*` as the provider factory.
// A root-level `createIPCServer` sorts before `createKiroAcp` ("I" < "K") and
// would shadow it, breaking `languageModel` resolution
// ("sdk.languageModel is not a function"). The root keeps `createKiroAcp` as
// the only `create*` export; the full IPC server surface lives here instead.
export {
  createIPCServer,
  type IPCServer,
  type IPCServerOptions,
  type IPCContentBlock,
  type PendingToolCall,
  type ToolResultRequest,
  type ToolExecuteResponse,
} from "./ipc-server"
