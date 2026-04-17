# kiro-acp-ai-provider

[Kiro](https://kiro.dev) provider for the [Vercel AI SDK](https://sdk.vercel.ai/) that uses `kiro-cli` via the [Agent Client Protocol (ACP)](https://docs.kiro.dev/acp). Implements `LanguageModelV3` with streaming and tool calling.

## Install

```bash
npm install kiro-acp-ai-provider @ai-sdk/provider ai
```

## Prerequisites

- **Node.js 18+** or **Bun**
- **kiro-cli** installed and authenticated:
  ```bash
  kiro-cli auth login
  ```
- **Kiro subscription** (Pro, Pro+, or Power)

## Quick Start

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

## How it works

```
Your App → AI SDK → kiro-acp-ai-provider → kiro-cli (ACP) → AWS Models
                          ↕ IPC (HTTP)
                    MCP Bridge (per-session)
```

The provider translates AI SDK calls into ACP messages sent to a `kiro-cli` subprocess over JSON-RPC stdio. Tool calls are relayed through an MCP bridge back to your application via IPC — the bridge does **not** execute tools, your harness does.

## Configuration

```typescript
const kiro = createKiroAcp({
  cwd: "/path/to/project",        // Working directory (default: process.cwd())
  agent: "my-agent",              // Custom agent name (--agent flag)
  trustAllTools: true,            // Auto-approve all tool calls
  agentPrompt: "You are a ...",   // Custom system prompt
  contextWindow: 200_000,         // Max context window in tokens (default: 1_000_000)
  sessionId: "previous-id",       // Resume an existing session
  env: { MY_VAR: "value" },       // Extra env vars for kiro-cli
  clientInfo: { name: "my-app", version: "1.0.0" },
  onPermission: (request) => ({   // Custom permission handler
    outcome: { outcome: "selected", optionId: "allow_once" },
  }),
})
```

## Provider Methods

```typescript
const model = kiro("claude-sonnet-4.6")     // Create a LanguageModelV3
const model = kiro.languageModel("claude-sonnet-4.6")  // Same thing

await kiro.shutdown()                        // Stop kiro-cli process
kiro.getClient()                             // Get underlying ACPClient
kiro.getSessionId()                          // Get session ID for persistence
await kiro.injectContext(summary)            // Rehydrate session context
kiro.getTotalCredits()                       // Total credits consumed
```

## Utilities

Standalone functions that don't require a running provider:

```typescript
import { verifyAuth, listModels, getQuota } from "kiro-acp-ai-provider"

// Check if kiro-cli is installed and authenticated
const status = verifyAuth()
// { installed: true, authenticated: true, version: "1.2.3", tokenPath: "..." }

// List available models (starts/stops kiro-cli temporarily)
const models = await listModels({ cwd: process.cwd() })

// Get per-session credit usage
const quota = await getQuota({ client: kiro.getClient() })
```

## Models

Available models depend on your subscription:

| Model ID | Description |
|----------|-------------|
| `claude-opus-4.6` | Most capable |
| `claude-sonnet-4.6` | Balanced |
| `claude-haiku-4.5` | Fastest |

Use `listModels()` for the current list.

## Tools

Tools work through the standard AI SDK contract. The provider includes an MCP bridge that reads tool definitions from a JSON file and relays calls to your harness via IPC. Pass custom tools through the AI SDK as usual — the provider handles the MCP bridge plumbing.

## Known Limitations

- **System prompt**: Kiro's base context is always present; yours is injected via `<system_instructions>` tags
- **No per-turn options**: Temperature, thinking toggle, etc. are controlled by kiro-cli
- **Estimated token counts**: Input tokens estimated from context usage %, output from character count
- **Single process**: One kiro-cli per provider instance; concurrent sessions use lane routing

## License

[MIT](./LICENSE) © Nacho F. Lizaur
