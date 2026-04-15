# kiro-acp-ai-provider

A **ToS-compliant** [Kiro](https://kiro.dev) provider for the [Vercel AI SDK](https://sdk.vercel.ai/) that uses the official `kiro-cli` via the [Agent Client Protocol (ACP)](https://docs.kiro.dev/acp) instead of direct API calls.

## How it works

```
Your App → AI SDK → kiro-acp-ai-provider → kiro-cli (ACP) → AWS Models
                            ↕
                      MCP Bridge Server
                   (tool execution layer)
```

Your application talks to the Vercel AI SDK as usual. This provider translates AI SDK calls into ACP messages sent to a `kiro-cli` subprocess over JSON-RPC stdio. The model runs server-side on AWS infrastructure — you never touch the API directly.

When the model needs to use tools (file reads, shell commands, etc.), those calls are routed through an MCP bridge server that `kiro-cli` spawns as a child process. You can provide custom tool definitions or use the built-in defaults.

## How it differs from `kiro-ai-provider`

| | `kiro-ai-provider` | `kiro-acp-ai-provider` |
|---|---|---|
| **Transport** | Direct HTTP to AWS APIs | `kiro-cli` subprocess (ACP over stdio) |
| **ToS compliance** | ⚠️ Potential concerns — bypasses official client | ✅ Uses the official CLI |
| **Authentication** | Manual credential management | Handled by `kiro-cli auth login` |
| **Tool execution** | You implement tool handlers | MCP bridge — tools run inside kiro-cli's sandbox |
| **System prompt** | Full control | Kiro's base context is always present; yours is injected via `<system_instructions>` tags |
| **Token counts** | Available from API | Not exposed by ACP |
| **Provider options** | Per-turn temperature, thinking, etc. | Not supported (kiro-cli controls these) |
| **Session state** | Stateless per request | Persistent session within process lifetime |

## Requirements

- **Node.js 18+** or **Bun**
- **kiro-cli** installed and authenticated:
  ```bash
  npm install -g @anthropic-ai/kiro-cli
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

Creates a provider instance that manages a single `kiro-cli` process.

```typescript
import { createKiroAcp } from "kiro-acp-ai-provider"

const kiro = createKiroAcp({
  // Working directory for kiro-cli (default: process.cwd())
  cwd: "/path/to/project",

  // Custom agent name passed via --agent flag
  agent: "my-agent",

  // Auto-approve all tool calls (default: false)
  trustAllTools: true,

  // Custom permission handler for tool call approvals
  onPermission: (request) => ({
    outcome: { outcome: "selected", optionId: "allow_once" },
  }),

  // Extra environment variables for the kiro-cli subprocess
  env: { MY_VAR: "value" },

  // Client info sent during the ACP initialize handshake
  clientInfo: { name: "my-app", version: "1.0.0" },
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

### `KiroACPProviderSettings`

```typescript
interface KiroACPProviderSettings {
  cwd?: string
  model?: string
  agent?: string
  trustAllTools?: boolean
  onPermission?: (request: PermissionRequest) => PermissionDecision
  env?: Record<string, string>
  clientInfo?: { name: string; version: string; title?: string }
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

## How tools work

Kiro-cli uses MCP (Model Context Protocol) servers to provide tools to the model. This provider includes an **MCP bridge server** that:

1. Reads tool definitions from a JSON file
2. Serves them to kiro-cli via the MCP protocol (stdio JSON-RPC)
3. Executes tool calls using built-in executors (bash, file I/O, glob, grep)
4. Returns results back to the model

### Built-in tools

The `getDefaultTools()` function returns definitions for:

| Tool | Description |
|------|-------------|
| `bash` | Execute shell commands |
| `read_file` | Read file contents with line numbers |
| `write_file` | Write content to a file |
| `edit_file` | Exact string replacement in files |
| `glob` | Find files by glob pattern |
| `grep` | Search file contents with regex |
| `list_directory` | List directory entries |

### Custom tools

You can provide your own tool definitions by writing a tools JSON file:

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

When the model calls a tool, the provider emits these stream parts:

1. `tool-input-start` — tool call begins (with `providerExecuted: true`)
2. `tool-input-delta` — the tool's input JSON
3. `tool-input-end` — input complete
4. `tool-call` — full tool call with input (with `providerExecuted: true`)
5. `tool-result` — the tool's output (executed by kiro-cli, not your app)

The `providerExecuted: true` flag tells the AI SDK that the tool was already executed server-side — your application doesn't need to handle it.

## Available models

Models available through kiro-cli (subject to your subscription tier):

| Model ID | Description |
|----------|-------------|
| `claude-opus-4.6` | Claude Opus 4.6 — most capable |
| `claude-sonnet-4.6` | Claude Sonnet 4.6 — balanced |
| `claude-haiku-4.5` | Claude Haiku 4.5 — fastest |

> **Note**: Available models depend on your Kiro subscription and what AWS exposes through kiro-cli. The model IDs above are based on testing — check `session.models.availableModels` for the current list.

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

- **Token overhead**: ~680 tokens baseline from kiro's system context (negligible on 200K context window)
- **System prompt**: Kiro's base context is always present — your system prompt is injected inside `<system_instructions>` tags
- **No per-turn provider options**: Temperature, thinking toggle, and other model parameters are controlled by kiro-cli, not configurable per-request
- **No token counts**: ACP doesn't expose input/output token usage
- **Session not persisted**: Sessions live within the `kiro-cli` process — they don't survive process restarts
- **Single process**: One `kiro-cli` process per provider instance — concurrent requests share the same session

## License

[MIT](./LICENSE) © Nacho F. Lizaur
