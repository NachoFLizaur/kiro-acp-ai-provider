# kiro-acp-ai-provider

A **ToS-compliant** [Kiro](https://kiro.dev) provider for the [Vercel AI SDK](https://sdk.vercel.ai/) that uses the official `kiro-cli` via the [Agent Client Protocol (ACP)](https://docs.kiro.dev/acp) instead of direct API calls.

## How it works

```
Your App → AI SDK → kiro-acp-ai-provider → kiro-cli (ACP) → AWS Models
                          ↕ IPC (HTTP)
                    MCP Bridge (per-session)
                   (pure relay, no execution)
```

Your application talks to the Vercel AI SDK as usual. This provider translates AI SDK calls into ACP messages sent to a `kiro-cli` subprocess over JSON-RPC stdio. The model runs server-side on AWS infrastructure — you never touch the API directly.

When the model needs to use tools, those calls are routed through an MCP bridge that relays them back to your application via IPC. The bridge does **not** execute tools — it acts as a pure relay between `kiro-cli` and your harness's tool execution pipeline. Your harness controls which tools are available by passing them to `doStream()`, following the standard AI SDK tool execution contract.

A **lane router** correlates IPC tool calls with the correct `doStream()` call, enabling parallel subagent sessions over a single `kiro-cli` process.

## How it differs from `kiro-ai-provider`

| | `kiro-ai-provider` | `kiro-acp-ai-provider` |
|---|---|---|
| **Transport** | Direct HTTP to AWS APIs | `kiro-cli` subprocess (ACP over stdio) |
| **ToS compliance** | ⚠️ Potential concerns — bypasses official client | ✅ Uses the official CLI |
| **Authentication** | Manual credential management | Handled by `kiro-cli auth login` |
| **Tool execution** | You implement tool handlers | MCP bridge + IPC — tools delegated back to your harness |
| **System prompt** | Full control | Kiro's base context is always present; yours is injected via `<system_instructions>` tags |
| **Token counts** | Available from API | Estimated from context usage percentage and output character counting |
| **Provider options** | Per-turn temperature, thinking, etc. | Not supported (kiro-cli controls these) |
| **Session state** | Stateless per request | Persistent session within process lifetime |

## Requirements

- **Node.js 18+** or **Bun**
- **kiro-cli** installed and authenticated — see [kiro.dev](https://kiro.dev) for installation instructions:
  ```bash
  kiro-cli auth login
  ```
- **Kiro subscription** — Pro, Pro+, or Power plan (for API key access)

## Installation

```bash
npm install kiro-acp-ai-provider
# or
bun add kiro-acp-ai-provider
```

The `@ai-sdk/provider` package is a peer dependency — install it alongside:

```bash
npm install @ai-sdk/provider ai
```

## Quick start

```typescript
import { createKiroAcp } from "kiro-acp-ai-provider"
import { streamText } from "ai"

const kiro = createKiroAcp({ cwd: process.cwd() })

const result = streamText({
  model: kiro("claude-sonnet-4.6"),
  prompt: "Write a hello world function in TypeScript",
})

for await (const text of result.textStream) {
  process.stdout.write(text)
}

await kiro.shutdown()
```

## API Reference

### `createKiroAcp(settings?)`

Creates a provider instance that manages a single `kiro-cli` process. Concurrent sessions are pooled automatically.

```typescript
import { createKiroAcp } from "kiro-acp-ai-provider"

const kiro = createKiroAcp({
  // Working directory for kiro-cli (default: process.cwd())
  cwd: "/path/to/project",

  // Custom agent name passed via --agent flag
  agent: "my-agent",

  // Auto-approve all tool calls (default: false)
  trustAllTools: true,

  // Custom system prompt for the agent config
  agentPrompt: "You are a helpful coding assistant.",

  // Custom permission handler for tool call approvals
  onPermission: (request) => ({
    outcome: { outcome: "selected", optionId: "allow_once" },
  }),

  // Extra environment variables for the kiro-cli subprocess
  env: { MY_VAR: "value" },

  // Client info sent during the ACP initialize handshake
  clientInfo: { name: "my-app", version: "1.0.0" },

  // Resume an existing session
  sessionId: "previous-session-id",

  // Model's max context window in tokens (default: 1_000_000)
  contextWindow: 200_000,
})
```

**Returns**: `KiroACPProvider` — a callable that creates language models:

```typescript
// These are equivalent:
const model = kiro("claude-sonnet-4.6")
const model = kiro.languageModel("claude-sonnet-4.6")
```

**Methods on the provider**:

| Method | Description |
|--------|-------------|
| `kiro(modelId)` | Create a `LanguageModelV3` for the given model ID |
| `kiro.languageModel(modelId)` | Same as above |
| `kiro.shutdown()` | Gracefully stop the `kiro-cli` process |
| `kiro.getClient()` | Get the underlying `ACPClient` for advanced usage |
| `kiro.getSessionId()` | Get the current ACP session ID for persistence |
| `kiro.injectContext(summary)` | Inject context summary for session rehydration |
| `kiro.getTotalCredits()` | Get total credits consumed across all turns |

### `KiroACPProviderSettings`

```typescript
interface KiroACPProviderSettings {
  cwd?: string
  model?: string
  agent?: string
  trustAllTools?: boolean
  agentPrompt?: string
  onPermission?: (request: PermissionRequest) => PermissionDecision
  env?: Record<string, string>
  clientInfo?: { name: string; version: string; title?: string }
  sessionId?: string
  contextWindow?: number
}
```

### `ACPClient`

Low-level client for direct ACP communication. Use `kiro.getClient()` or construct directly:

```typescript
import { ACPClient } from "kiro-acp-ai-provider"

const client = new ACPClient({ cwd: process.cwd() })
await client.start()

const session = await client.createSession()
const result = await client.prompt({
  sessionId: session.sessionId,
  prompt: [{ type: "text", text: "Hello!" }],
  onUpdate: (update) => console.log(update),
})

await client.stop()
```

**Key methods**:

| Method | Description |
|--------|-------------|
| `start()` | Spawn `kiro-cli acp` and perform the initialize handshake |
| `stop()` | Gracefully stop the subprocess |
| `createSession()` | Create a new ACP session |
| `prompt(options)` | Send a prompt and stream updates |
| `setModel(sessionId, modelId)` | Switch the model for a session |
| `setMode(sessionId, modeId)` | Switch the agent mode |
| `executeCommand(sessionId, command, args)` | Execute a kiro slash command |
| `getMetadata(sessionId)` | Get cached session metadata |
| `isRunning()` | Check if the subprocess is alive |

### Utilities

Standalone utility functions that don't require a running provider instance:

```typescript
import { verifyAuth, listModels, getQuota } from "kiro-acp-ai-provider"
```

#### `verifyAuth()`

Check if `kiro-cli` is installed and authenticated without starting a process:

```typescript
const status = verifyAuth()
// { installed: true, authenticated: true, version: "1.2.3", tokenPath: "..." }
```

#### `listModels(options?)`

List available models by temporarily starting `kiro-cli`:

```typescript
const models = await listModels({ cwd: process.cwd() })
// [{ id: "claude-sonnet-4.6", ... }, ...]
```

#### `getQuota(options?)`

Get per-session credit usage and context window consumption:

```typescript
const quota = await getQuota({ client: kiro.getClient() })
// { sessionCredits: 12, contextUsagePercentage: 3.2, metering: [...] }
```

> **Note**: ACP does not expose full subscription details (plan type, monthly limits). This returns per-session usage data.

## How tools work

`kiro-cli` uses MCP (Model Context Protocol) servers to provide tools to the model. This provider includes an **MCP bridge** that:

1. Reads tool definitions from a JSON file (written by the provider from your `doStream()` tools)
2. Serves them to `kiro-cli` via the MCP protocol (stdio JSON-RPC)
3. Relays tool calls back to your application via an IPC HTTP server
4. Returns results back to the model

The bridge is a **pure relay** — it does not execute tools. Your harness (the application calling `doStream()`) is responsible for tool execution, following the standard AI SDK tool execution contract.

### Tool superset merging

When multiple agents share a `kiro-cli` process, each may pass a different set of tools to `doStream()`. The provider merges all tool definitions into a **superset** (union) in the shared tools file. This ensures that switching between agents never evicts another agent's tools. Per-agent tool permissions are enforced at execution time by the harness, not the bridge.

### Default tools

The `getDefaultTools()` function returns fallback definitions for common coding tools:

| Tool | Description |
|------|-------------|
| `bash` | Execute shell commands |
| `read_file` | Read file contents with line numbers |
| `write_file` | Write content to a file |
| `edit_file` | Exact string replacement in files |
| `glob` | Find files by glob pattern |
| `grep` | Search file contents with regex |
| `list_directory` | List directory entries |

These are **fallback defaults** for when the harness doesn't provide its own tool definitions. In practice, the harness controls which tools are available by passing them to `doStream()`.

### Custom tools

Extend or replace the defaults by passing tools through the AI SDK:

```typescript
import { getDefaultTools, type MCPToolsFile } from "kiro-acp-ai-provider"

const toolsFile: MCPToolsFile = {
  tools: [
    ...getDefaultTools(),
    {
      name: "my_custom_tool",
      description: "Does something custom",
      inputSchema: {
        type: "object",
        properties: {
          input: { type: "string", description: "The input" },
        },
        required: ["input"],
      },
    },
  ],
  cwd: process.cwd(),
}
```

### Tool calls in the stream

When the model calls a tool, the provider emits standard AI SDK tool-call stream parts:

1. `tool-input-start` — tool call begins
2. `tool-input-delta` — the tool's input JSON
3. `tool-input-end` — input complete
4. `tool-call` — full tool call with input
5. `finish` with `finishReason: "tool-calls"`

The harness (your application) is responsible for executing the tool and calling `doStream()` again with the tool result. This follows the standard AI SDK tool execution contract — no special handling is needed.

### Per-session lane routing

The `LaneRouter` correlates IPC tool calls with the correct `doStream()` call using tool name + argument matching. This enables concurrent subagent sessions over a single `kiro-cli` process:

- **Single-lane fast path**: When only one `doStream()` is active (the common case), correlation is skipped entirely.
- **Multi-lane routing**: When multiple `doStream()` calls are active in parallel, the router matches IPC calls to the correct lane via ACP notification correlation.
- **Buffered fallback**: If an IPC call arrives before its ACP notification, it's buffered and matched when the notification arrives.

## Available models

Models available through `kiro-cli` (subject to your subscription tier):

| Model ID | Description |
|----------|-------------|
| `claude-opus-4.6` | Claude Opus 4.6 — most capable |
| `claude-sonnet-4.6` | Claude Sonnet 4.6 — balanced |
| `claude-haiku-4.5` | Claude Haiku 4.5 — fastest |

> **Note**: Available models depend on your Kiro subscription and what AWS exposes through `kiro-cli`. Use `listModels()` or check `session.models.availableModels` for the current list.

## Agent configuration

The provider can generate kiro agent configuration files for the MCP bridge:

```typescript
import { generateAgentConfig, writeAgentConfig } from "kiro-acp-ai-provider"

const config = generateAgentConfig({
  mcpBridgePath: "/path/to/mcp-bridge.js",
  toolsFilePath: "/path/to/tools.json",
  cwd: process.cwd(),
  prompt: "You are a helpful coding assistant.",
})

// Write to .kiro/agents/my-agent.json
const configPath = writeAgentConfig(process.cwd(), "my-agent", config)
```

## Known limitations

- **Token overhead**: ~1.14% of context window from Kiro's system context (system prompt, built-in tools, agent instructions). Negligible on a 200K+ context window.
- **System prompt**: Kiro's base context is always present — your system prompt is injected inside `<system_instructions>` tags
- **No per-turn provider options**: Temperature, thinking toggle, and other model parameters are controlled by `kiro-cli`, not configurable per-request
- **Estimated token counts**: ACP doesn't expose exact token usage — the provider estimates input tokens from context usage percentage × context window, and output tokens from streamed character count (~1 token per 4 characters)
- **Session persistence**: Sessions can be persisted via `getSessionId()` / `sessionId` option, but depend on `kiro-cli`'s session storage
- **Single process**: One `kiro-cli` process per provider instance — concurrent sessions are pooled automatically via lane routing

## License

[MIT](./LICENSE) © Nacho F. Lizaur
